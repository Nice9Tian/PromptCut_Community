/**
 * 字幕行:把字幕卡 `lines` 参数里那一坨字符串,变成时间轴能画、能拖的一条条段落。
 *
 * 字幕在这个项目里一直是「一张 caption-track 卡盖住整段,内容全塞进它的 lines 参数」。
 * 画面上没问题(卡片自己按时间切换当前句),但时间轴上只剩一个色块 —— 每句话从几秒到
 * 几秒、哪句压到了哪个镜头上,一概看不见,也没法拖。这里把那串文本解析成结构化的行,
 * 时间轴据此在字幕卡内部画出一条条子段落,拖动 / 改字再写回同一个字符串。
 *
 * 存储格式没变(仍然是 `起|止|中|英`,换行或 `//` 分条,秒数相对 clip 起点),
 * 所以老项目文件、fill_captions、卡片组件三边都不用动。
 *
 * 纯字符串和数字计算,不碰 store、不碰 DOM。
 */

import { timelineSpanOf, timelineTimeAt } from "./clipTime.mjs";

/** 一条字幕。start / end 是**相对字幕卡起点**的秒数,和 lines 里写的一样 */
export interface CaptionLine {
  start: number;
  end: number;
  /** 主字幕(中文行)。用 *星号* 包住的词会被卡片按主色高亮 */
  zh: string;
  /** 副字幕(英文行),可以是空串 */
  en: string;
}

/** 字幕卡的 cardId。判断「这段是不是字幕」都走 isCaptionClip,别到处写字符串 */
export const CAPTION_CARD_ID = "caption-track";

/** 字幕专用序列的名字。auto_workflow / add_clip 建字幕卡时都往这条上放 */
export const CAPTION_TRACK_NAME = "字幕";

/** 一条字幕最短多久(秒):再短就点不中也读不完 */
export const MIN_CAPTION_DUR = 0.2;

/** 这段是不是字幕卡 */
export function isCaptionClip(clip: { cardId?: string } | null | undefined): boolean {
  return !!clip && clip.cardId === CAPTION_CARD_ID;
}

function num(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 一行里不能出现 `|` 和换行,否则写回去就把格式冲散了 */
function clean(s: string): string {
  return s.replace(/[\r\n|]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 解析 lines。坏行(秒数不是数、起止反了、整行空)直接丢掉 —— 时间轴宁可少画一条,
 * 也不要画一条 NaN 宽的块出来。解析完按起点排序,后面所有下标都以排序后的为准。
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

/** 写回 lines 参数。格式和 fill_captions 生成的完全一致(末尾那根 `|` 是留给英文行的) */
export function formatCaptions(lines: CaptionLine[]): string {
  return [...lines]
    .sort((x, y) => x.start - y.start)
    .map((l) => `${round(l.start)}|${round(l.end)}|${clean(l.zh)}|${clean(l.en)}`)
    .join("\n");
}

/** 从一段字幕卡里取出它的行 */
export function captionsOf(clip: { params?: Record<string, unknown> } | null | undefined): CaptionLine[] {
  return parseCaptions(clip?.params?.lines);
}

/** 此刻(相对 clip 起点的秒)该显示第几条;没有就是 -1。和卡片组件一个口径 */
export function captionIndexAt(lines: CaptionLine[], tRel: number): number {
  return lines.findIndex((l) => tRel >= l.start && tRel < l.end);
}

/** 一条字幕在时间轴上的绝对位置 */
export interface CaptionSpan extends CaptionLine {
  index: number;
  /** 时间轴上的绝对秒 */
  from: number;
  to: number;
}

/**
 * 字幕卡里的行 → 时间轴上的绝对位置。超出卡片时段的部分裁掉;整条都在卡外的直接不给
 * (卡片本来也不会显示它们,时间轴上画出来只会让人以为那句会播)。
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
 * 一条字幕能挪到哪:卡片内、且不越过左右邻居。
 * 时间轴上拖动时先问它,拖到头就贴住,不会拖出一条压着别人的字幕。
 */
export function captionBounds(lines: CaptionLine[], index: number, dur: number): { min: number; max: number } {
  const prev = index > 0 ? lines[index - 1] : null;
  const next = index < lines.length - 1 ? lines[index + 1] : null;
  return { min: prev ? prev.end : 0, max: next ? next.start : dur };
}

/**
 * 改一条字幕(挪位置、改时长、改文字)。
 *
 * 时间会被夹进 `captionBounds` 给的范围,并保证至少 MIN_CAPTION_DUR 长;
 * 只给 start 就理解成「整条平移」,长度不变(和时间轴上拖动条的手感一致)。
 * 返回新数组和这条改完之后排到了第几位 —— 顺序可能因为平移而变。
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
      // 只给起点 = 平移:长度留住,顶到邻居就贴住
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

/** 删掉一条 */
export function removeCaption(lines: CaptionLine[], index: number): CaptionLine[] {
  if (index < 0 || index >= lines.length) return lines;
  return lines.filter((_, i) => i !== index);
}

/**
 * 插一条新字幕。给的时段会被挤进最近的空当里:落点被占住就往后找,
 * 一直到卡片末尾都塞不下就返回 index -1(调用方据此提示「这儿没地方了」)。
 */
export function insertCaption(
  lines: CaptionLine[],
  at: { start: number; end?: number; zh?: string; en?: string },
  dur: number,
): { lines: CaptionLine[]; index: number } {
  const want = Math.max(0, Math.min(at.start, dur));
  const len = Math.max(MIN_CAPTION_DUR, (at.end ?? want + 2) - want);
  const sorted = [...lines].sort((x, y) => x.start - y.start);

  // 从落点往后找第一个放得下的空当(含最后一条之后到卡片末尾)
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

/** 时间轴上引用了某份素材的一段(只要算时间用得到的那几个字段) */
export interface MediaPlacement {
  start: number;
  end: number;
  mediaId?: string;
  mediaOffset?: number;
  /** 片段速度(缺省 1),见 kernel/clipTime.mjs */
  speed?: number;
}

/**
 * 素材内的第几秒 → 时间轴上的第几秒。
 *
 * 文字稿的秒数是**素材内**的,时间轴上这段素材可能被挪到了第 30 秒、还从第 8 秒开始播。
 * 不换算就直接当时间轴秒用,字幕会整体错位 —— 素材放在开头且没修头时两者恰好相等,
 * 所以这个坑很久都没被踩出来。落在素材没被用到的部分就返回 null(那句话根本不会播)。
 */
export function mapMediaTime(clips: MediaPlacement[], mediaId: string, mediaSec: number): number | null {
  return placeMediaTime(clips, mediaId, mediaSec)?.tl ?? null;
}

/** 同 mapMediaTime,另回落在哪一段上(要按那一段的速度换算句长) */
function placeMediaTime(clips: MediaPlacement[], mediaId: string, mediaSec: number): { tl: number; clip: MediaPlacement } | null {
  for (const c of clips) {
    if (c.mediaId !== mediaId) continue;
    // 素材秒 → 时间轴秒按 kernel/clipTime.mjs 的统一换算(含片段速度)
    const tl = timelineTimeAt(c, mediaSec);
    if (tl >= c.start - 1e-6 && tl < c.end) return { tl, clip: c };
  }
  return null;
}

/** 文字稿里的一段(只要这三个字段) */
export interface TranscriptLike {
  start: number;
  end: number;
  text: string;
}

/**
 * 一份文字稿 → 一张字幕卡该有的内容:铺多长、每条什么时候出。
 *
 * 段落先按 mapMediaTime 换算到时间轴上,再整体减去卡片起点变成相对秒。
 * range 不给就按「这份文字稿在时间轴上铺开的范围」自己算(也就是新建卡片时用的时段)。
 * 没有一段落在范围内时返回空 lines,调用方据此报错,而不是建一张空字幕卡。
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
    // 末尾那一刻正好落在 clip 边界上,mapMediaTime 会判成「不在里面」,所以止点自己按时长推(素材时长按那一段的速度折成时间轴时长)
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

/** 给人看的一句话:「第 3 条 · 1.20–3.40s · 大家好」 */
export function describeCaption(l: CaptionLine, index: number): string {
  const text = l.zh || l.en || "(空)";
  return `第 ${index + 1} 条 · ${round(l.start)}–${round(l.end)}s · ${text.slice(0, 20)}`;
}
