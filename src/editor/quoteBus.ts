/**
 * Global entry point for "quote this into the AI input box".
 *
 * There is more than one caller: right-clicking a card in the preview, or right-clicking a clip or
 * an overlay card inside a band on the timeline.
 * There is also more than one listener: the desktop local AI panel, the Cloud AI panel, and the
 * Agent tab of the mobile app (which puts it in the marker bar rather than the input box).
 * The two sides are separated by several component layers and share no UI state, so a window
 * event bridges them, the same approach as `left/captionsBus.ts`.
 *
 * The event name and the detail fields stay as before (`clipId` / `label` / `cardId`), so old
 * callers need no changes at all.
 * The quote block is written in exactly one place, `quoteToken`: previously the local AI panel and
 * the Cloud AI panel each built their own `@card …(…)`, so adding the "overlay card" level meant
 * changing both, and missing one would make the other panel quote the wrong level.
 */
import { quoteToken } from "../mobile/agentView";
import { tr } from "../i18n/index.ts";

const EVENT = "pc-quote-clip";

export interface QuoteDetail {
  /** The id of the quoted thing: for a clip it is the clip id; for an overlay card it is "clipId#kind:definitionId" */
  clipId: string;
  /** The human-readable name */
  label?: string;
  /** Which level is quoted: omitted = the whole clip (`@card`); a single overlay card is written as "overlay card" */
  kind?: string;
  /** Old callers (preview right-click) still pass this; it is only used as a fallback name */
  cardId?: string;
}

export interface QuoteRead {
  id: string;
  label: string;
  kind?: string;
  /** The string inserted into the input box */
  token: string;
}

export function requestQuote(q: QuoteDetail): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: q }));
}

/** Read an event: the name falls back in the order label → cardId → "Untitled"; the quote block is always written by quoteToken */
export function readQuote(ev: Event): QuoteRead | null {
  const d = ((ev as CustomEvent).detail || {}) as Partial<QuoteDetail>;
  const id = typeof d.clipId === "string" ? d.clipId : "";
  if (!id) return null;
  const label =
    (typeof d.label === "string" && d.label) ||
    (typeof d.cardId === "string" && d.cardId) ||
    tr("Untitled");
  const kind = typeof d.kind === "string" && d.kind ? d.kind : undefined;
  return { id, label, kind, token: quoteToken({ id, label, kind }) };
}

export function onQuoteRequest(fn: (q: QuoteRead) => void): () => void {
  const handler = (ev: Event) => {
    const q = readQuote(ev);
    if (q) fn(q);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
