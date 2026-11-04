/**
 * Caption lines: turns the string blob in the caption card's `lines` parameter into paragraphs
 * that the timeline can draw and drag.
 *
 * Captions in this project have always been "a single caption-track card covering the whole cut,
 * with all content packed into its lines parameter." On screen this is fine (the card switches the
 * current sentence on its own based on time), but the timeline is left with only a single color
 * block: you cannot see from what second to what second each sentence runs, which sentence overlaps
 * which shot, and you cannot drag them. Here, that text string is parsed into structured lines,
 * from which the timeline draws sub-segments inside the caption card, writing back to the same
 * string after dragging or editing text.
 *
 * Storage format remains unchanged (still `start|end|zh|en`, separated by newlines or `//`, with seconds
 * relative to clip start), so legacy project files, fill_captions, and card components all remain
 * untouched.
 *
 * Pure string and numeric calculations, does not touch store or DOM.
 */

import { timelineSpanOf, timelineTimeAt } from "./clipTime.mjs";

/** A caption. start / end are seconds **relative to caption card start**, matching lines */
export interface CaptionLine {
  start: number;
  end: number;
  /** Main caption (Chinese line). Words enclosed in *asterisks* are highlighted in primary color by card */
  zh: string;
  /** Secondary caption (English line), can be empty string */
  en: string;
}

/** cardId of caption card. Use isCaptionClip to check if clip is a caption, don't hardcode strings */
export const CAPTION_CARD_ID = "caption-track";

/** Dedicated caption track name. auto_workflow / add_clip place caption cards on this track */
export const CAPTION_TRACK_NAME = "Captions";

/** Minimum caption duration (seconds): shorter captions cannot be clicked or read */
export const MIN_CAPTION_DUR = 0.2;

/** Whether this clip is a caption card */
export function isCaptionClip(clip: { cardId?: string } | null | undefined): boolean {
  return !!clip && clip.cardId === CAPTION_CARD_ID;
}

function num(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

/** A line cannot contain `|` or newlines, otherwise writing back breaks the format */
function clean(s: string): string {
  return s.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parses lines. Bad lines (seconds not a number, start/end reversed, entire line empty) are
 * dropped directly: the timeline would rather draw one fewer line than draw a block with NaN width.
 * Sorted by start after parsing; all subsequent indices are based on sorted order.
 */
export function parseCaptions(raw: unknown): CaptionLine[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const out: CaptionLine[] = [];
  for (const part of raw.split(/\r?\n|\/\//)) {
    const p = part.trim();
    if (!p) continue;
    const [a, b, zh, en] = p.split("|");
    const start = num(a ?? "");
    const end = num(b ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const line: CaptionLine = { start, end, zh: clean(zh ?? ""), en: clean(en ?? "") };
    if (!line.zh && !line.en) continue;
    out.push(line);
  }
  return out.sort((x, y) => x.start - y.start);
}

function round(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Write back to lines parameter. Format matches fill_captions output exactly (trailing `|` is for English line) */
export function formatCaptions(lines: CaptionLine[]): string {
  return [...lines]
    .sort((x, y) => x.start - y.start)
    .map((l) => `${round(l.start)}|${round(l.end)}|${clean(l.zh)}|${clean(l.en)}`)
    .join("\n");
}

/** Extract lines from a caption card clip */
export function captionsOf(clip: { params?: Record<string, unknown> } | null | undefined): CaptionLine[] {
  return parseCaptions(clip?.params?.lines);
}

/** Caption index to display at this moment (seconds relative to clip start); -1 if none. Matches card component */
export function captionIndexAt(lines: CaptionLine[], tRel: number): number {
  return lines.findIndex((l) => tRel >= l.start && tRel < l.end);
}

/** Absolute position of a caption on the timeline */
export interface CaptionSpan extends CaptionLine {
  index: number;
  /** Absolute seconds on the timeline */
  from: number;
  to: number;
}

/**
 * Lines in caption card → absolute positions on timeline. Parts exceeding card time span are
 * trimmed; lines entirely outside card are omitted directly (the card would not display them
 * anyway, and drawing them on the timeline would mislead people into thinking they play).
 */
export function captionSpans(clip: { start: number; end: number; params?: Record<string, unknown> }): CaptionSpan[] {
  const dur = clip.end - clip.start;
  const out: CaptionSpan[] = [];
  captionsOf(clip).forEach((l, index) => {
    const start = Math.max(0, Math.min(l.start, dur));
    const end = Math.max(0, Math.min(l.end, dur));
    if (end - start < 1e-6) return;
    out.push({ ...l, index, from: clip.start + start, to: clip.start + end });
  });
  return out;
}

/**
 * Where a caption can be moved: within card and without crossing left or right neighbors.
 * Queried first when dragging on timeline; snaps to edge when reaching boundary, preventing
 * a caption from dragging over another.
 */
export function captionBounds(lines: CaptionLine[], index: number, dur: number): { min: number; max: number } {
  const prev = index > 0 ? lines[index - 1] : null;
  const next = index < lines.length - 1 ? lines[index + 1] : null;
  return { min: prev ? prev.end : 0, max: next ? next.start : dur };
}

/**
 * Modifies a caption (move position, change duration, edit text).
 *
 * Time is clamped within the range given by `captionBounds`, guaranteed to be at least
 * MIN_CAPTION_DUR long; providing only start is interpreted as "shift entire line", keeping
 * duration unchanged (matching the feel of dragging bars on the timeline).
 * Returns new array and the updated index of this item: order may change due to translation.
 */
export function editCaption(
  lines: CaptionLine[],
  index: number,
  patch: { start?: number; end?: number; zh?: string; en?: string },
  dur: number,
): { lines: CaptionLine[]; index: number } {
  const cur = lines[index];
  if (!cur) return { lines, index: -1 };

  let start = cur.start;
  let end = cur.end;
  if (patch.start !== undefined || patch.end !== undefined) {
    const { min, max } = captionBounds(lines, index, dur);
    if (patch.start !== undefined && patch.end === undefined) {
      // Only start provided = shift: preserve duration, clamp against neighbors when hitting boundary
      const len = cur.end - cur.start;
      start = Math.max(min, Math.min(patch.start, Math.max(min, max - len)));
      end = Math.min(max, start + len);
    } else {
      start = Math.max(min, Math.min(patch.start ?? cur.start, max - MIN_CAPTION_DUR));
      end = Math.min(max, Math.max(patch.end ?? cur.end, start + MIN_CAPTION_DUR));
      if (end - start < MIN_CAPTION_DUR) end = Math.min(max, start + MIN_CAPTION_DUR);
    }
  }

  const next: CaptionLine = {
    start,
    end,
    zh: patch.zh !== undefined ? clean(patch.zh) : cur.zh,
    en: patch.en !== undefined ? clean(patch.en) : cur.en,
  };
  const out = lines.map((l, i) => (i === index ? next : l)).sort((x, y) => x.start - y.start);
  return { lines: out, index: out.indexOf(next) };
}

/** Delete a caption */
export function removeCaption(lines: CaptionLine[], index: number): CaptionLine[] {
  if (index < 0 || index >= lines.length) return lines;
  return lines.filter((_, i) => i !== index);
}

/**
 * Inserts a new caption. The provided interval is squeezed into the nearest gap: if drop target
 * is occupied, searches forward; if it cannot fit all the way to card end, returns index -1
 * (caller prompts "No space here" accordingly).
 */
export function insertCaption(
  lines: CaptionLine[],
  at: { start: number; end?: number; zh?: string; en?: string },
  dur: number,
): { lines: CaptionLine[]; index: number } {
  const want = Math.max(0, Math.min(at.start, dur));
  const len = Math.max(MIN_CAPTION_DUR, (at.end ?? want + 2) - want);
  const sorted = [...lines].sort((x, y) => x.start - y.start);

  // Search forward from drop target for first gap that fits (including after last caption to card end)
  let cursor = want;
  for (const l of sorted) {
    if (l.end <= cursor) continue;
    if (l.start - cursor >= MIN_CAPTION_DUR) break;
    cursor = l.end;
  }
  const nextStart = sorted.find((l) => l.start >= cursor)?.start ?? dur;
  if (nextStart - cursor < MIN_CAPTION_DUR || cursor >= dur) return { lines, index: -1 };

  const line: CaptionLine = {
    start: cursor,
    end: Math.min(nextStart, dur, cursor + len),
    zh: clean(at.zh ?? ""),
    en: clean(at.en ?? ""),
  };
  const out = [...sorted, line].sort((x, y) => x.start - y.start);
  return { lines: out, index: out.indexOf(line) };
}

/** A clip on the timeline referencing media (only fields needed for time calculation) */
export interface MediaPlacement {
  start: number;
  end: number;
  mediaId?: string;
  mediaOffset?: number;
  /** Clip speed (default 1), see kernel/clipTime.mjs */
  speed?: number;
}

/**
 * Second within media → second on timeline.
 *
 * Transcript seconds are **within media**; on the timeline, this media clip might have been moved
 * to second 30 and play starting from second 8. Using them as timeline seconds without conversion
 * will offset captions globally: when media is placed at the start without trimming the head, both
 * happen to be equal, which is why this pitfall went unnoticed for a long time. Returns null if it
 * falls within an unused part of media (that sentence will not play at all).
 */
export function mapMediaTime(clips: MediaPlacement[], mediaId: string, mediaSec: number): number | null {
  return placeMediaTime(clips, mediaId, mediaSec)?.tl ?? null;
}

/** Like mapMediaTime, also returns which clip it falls into (to convert line duration using clip speed) */
function placeMediaTime(clips: MediaPlacement[], mediaId: string, mediaSec: number): { tl: number; clip: MediaPlacement } | null {
  for (const c of clips) {
    if (c.mediaId !== mediaId) continue;
    // Media seconds → timeline seconds uses unified conversion in kernel/clipTime.mjs (including clip speed)
    const tl = timelineTimeAt(c, mediaSec);
    if (tl >= c.start - 1e-6 && tl < c.end) return { tl, clip: c };
  }
  return null;
}

/** A segment in the transcript (only these three fields needed) */
export interface TranscriptLike {
  start: number;
  end: number;
  text: string;
}

/**
 * A transcript → the intended content of a caption card: how long it spans, when each item
 * appears.
 *
 * Paragraphs are first converted to the timeline via mapMediaTime, then the card start is subtracted
 * overall to become relative seconds.
 * If range is not provided, calculate it from "the span of this transcript on the timeline"
 * (which is the time span used when creating a new card).
 * When no paragraph falls within range, returns empty lines; the caller reports an error
 * accordingly, rather than creating an empty caption card.
 */
export function captionsFromTranscript(
  clips: MediaPlacement[],
  mediaId: string,
  segments: TranscriptLike[],
  range?: { from: number; to: number },
): { from: number; to: number; lines: CaptionLine[] } {
  const mapped: { from: number; to: number; text: string }[] = [];
  for (const s of segments) {
    const hit = placeMediaTime(clips, mediaId, s.start);
    if (hit == null) continue;
    const from = hit.tl;
    // If the final moment falls right on the clip boundary, mapMediaTime treats it as "not inside",
    // so calculate the end point from duration (asset duration converted to timeline duration by that
    // segment's speed)
    const to = from + timelineSpanOf(hit.clip, Math.max(0, s.end - s.start));
    const text = clean(s.text);
    if (!text || to <= from) continue;
    mapped.push({ from, to, text });
  }
  if (mapped.length === 0) return { from: range?.from ?? 0, to: range?.to ?? 0, lines: [] };

  const from = range?.from ?? Math.min(...mapped.map((m) => m.from));
  const to = range?.to ?? Math.max(...mapped.map((m) => m.to));
  const lines = mapped
    .filter((m) => m.to > from && m.from < to)
    .map((m) => ({ start: Math.max(m.from, from) - from, end: Math.min(m.to, to) - from, zh: m.text, en: "" }))
    .filter((l) => l.end - l.start > 1e-6)
    .sort((a, b) => a.start - b.start);
  return { from, to, lines };
}

/** A human-readable line: "Item 3 · 1.20–3.40s · Hello everyone" */
export function describeCaption(l: CaptionLine, index: number): string {
  const text = l.zh || l.en || "(empty)";
  return `Caption ${index + 1} · ${round(l.start)}–${round(l.end)}s · ${text.slice(0, 20)}`;
}
