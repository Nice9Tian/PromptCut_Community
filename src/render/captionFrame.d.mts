type CaptionLine = { start: number; end: number; zh: string; en: string };
type CaptionEvent = { at: number; index: number; entryAt: number; exitAt: number | null; nextIndex: number; exitOpacity: number; exitY: number };
export function compileCaptionFrames(raw: string): { lines: CaptionLine[]; events: CaptionEvent[] };
export function captionFrameAt(compiled: ReturnType<typeof compileCaptionFrames>, t: number): { index: number; line: CaptionLine; opacity: number; y: number } | null;
