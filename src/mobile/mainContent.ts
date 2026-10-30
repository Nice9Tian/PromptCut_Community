/**
 * 手机版缩略时间轴的「主要内容」(语义 `workflow/editing.md`「手机版界面」;术语 `glossary.md`「主要内容」;
 * 机制 `mechanism/platforms.md`「手机版缩略时间轴的主要内容」)。
 *
 * 取法分两步(2026-10-23 用户定:「需要一个算法来精简的匹配……先跑通(能显示出来东西,开始时间-结尾时间都有缩略图)」):
 * 1. **主轨**:当前剪辑的主轨(最底下那条放着视频 / 图片 / 剪辑段的序列)上的视频段、图片段、剪辑段,
 *    加上被它们交叉溶解过去的后一段(溶解会把后一段挪到别的序列上,`kernel/transitions.ts`)。
 * 2. **补空档**:从 0 到最后一段可见内容的结尾,第 1 步没盖住、长于 `GAP_MIN` 的空档,用其余没隐藏的序列上的
 *    可见段(声音段不算)按时间补上:每到一处空档,在盖住这一刻的段里挑时长最长的(一样长挑序列更靠下的),
 *    这一刻没有段盖住就跳到空档里最早开始的那段;补进来的段只取它落在空档里的那一截(剪掉和第 1 步重叠的部分),
 *    所以同一时刻只有一块、块的时间先后不交叉。一段很长的段(例如垫在底下的背景卡)可以在几处空档各补一截,
 *    这时同一个 id 会出现不止一次。只有卡片的项目第 1 步一块都没有,整条都靠第 2 步补。
 *
 * 纯函数:只读 Project,不碰 store。补进来又被剪过的段是新对象(id 不变),不是项目里的那个。
 */
import { isImageMedia, type MediaAsset, type Project, type Track, type TrackClip } from "../kernel/project.ts";
import { transitionsOf, timingLock, type Transition } from "../kernel/transitions.ts";

export type ClipKind = "video" | "image" | "audio" | "cut" | "card";

function mediaOf(p: Project, clip: TrackClip): MediaAsset | undefined {
  return clip.mediaId ? p.media.find((m) => m.id === clip.mediaId) : undefined;
}

export function clipKind(p: Project, clip: TrackClip): ClipKind {
  if (clip.cutId) return "cut";
  const m = mediaOf(p, clip);
  if (m) return m.kind === "audio" ? "audio" : isImageMedia(m) ? "image" : "video";
  return "card";
}

/** 能当主要内容的段:视频段、图片段、剪辑段 */
export function isMainKind(p: Project, clip: TrackClip): boolean {
  const k = clipKind(p, clip);
  return k === "video" || k === "image" || k === "cut";
}

/** 主轨:最底下(tracks 的最后一条)那条放着主要内容的序列;都没有就是最底下那条 */
export function mainTrackOf(p: Project): Track | undefined {
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    if (p.tracks[i].clips.some((c) => isMainKind(p, c))) return p.tracks[i];
  }
  return p.tracks[p.tracks.length - 1];
}

/** 空档短于这个就不补(秒);整条可见内容很短时按它的 5% 算,保证短项目也补得上。见文件头第 2 步 */
const GAP_MIN = 0.5;
const GAP_FRAC = 0.05;
const EPS = 1e-6;

/** 第 1 步:主轨上的视频 / 图片 / 剪辑段,加被它们溶解过去的后一段 */
function mainTrackClips(p: Project): TrackClip[] {
  const track = mainTrackOf(p);
  if (!track) return [];
  const picked = new Map<string, TrackClip>();
  for (const c of track.clips) if (isMainKind(p, c)) picked.set(c.id, c);
  // 被溶解过去的后一段(可能在别的序列上)也算
  const all = new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const tr of transitionsOf(p)) {
      if (tr.kind !== "crossfade" || !tr.bId || !picked.has(tr.aId) || picked.has(tr.bId)) continue;
      const b = all.get(tr.bId);
      if (b && isMainKind(p, b)) { picked.set(b.id, b); grew = true; }
    }
  }
  return [...picked.values()];
}

/** 补进来的段只留 [s, e) 这一截;视频段的入点跟着往后挪,缩略图取的仍是这一截开头那一帧 */
function trimTo(c: TrackClip, s: number, e: number): TrackClip {
  if (Math.abs(s - c.start) < EPS && Math.abs(e - c.end) < EPS) return c;
  const out: TrackClip = { ...c, start: s, end: e };
  if (c.mediaId && s > c.start) out.mediaOffset = (c.mediaOffset ?? 0) + (s - c.start);
  return out;
}

export function mainClipsOf(p: Project): TrackClip[] {
  const base = mainTrackClips(p);
  const taken = new Set(base.map((c) => c.id));
  // 候选:没隐藏的序列上、还没取的可见段;记下序列位置(越大越靠下)
  const cands: { c: TrackClip; lvl: number }[] = [];
  p.tracks.forEach((t, lvl) => {
    if (t.hidden) return;
    for (const c of t.clips) if (!taken.has(c.id) && c.end - c.start > EPS && clipKind(p, c) !== "audio") cands.push({ c, lvl });
  });
  const end = Math.max(0, ...base.map((c) => c.end), ...cands.map((x) => x.c.end));
  const gapMin = Math.min(GAP_MIN, end * GAP_FRAC);
  // 第 1 步没盖住的空档
  const covered = [...base].sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let x = 0;
  for (const c of covered) {
    if (c.start > x + EPS) gaps.push([x, c.start]);
    x = Math.max(x, c.end);
  }
  if (end > x + EPS) gaps.push([x, end]);
  const out = [...base];
  for (const [g0, g1] of gaps) {
    if (g1 - g0 < gapMin) continue;
    let at = g0;
    while (at < g1 - EPS) {
      const live = cands.filter((k) => k.c.end > at + EPS && k.c.start < g1 - EPS);
      if (!live.length) break;
      const here = live.filter((k) => k.c.start <= at + EPS);
      if (!here.length) { at = Math.min(...live.map((k) => k.c.start)); continue; }
      const best = here.reduce((a, b) => {
        const da = a.c.end - a.c.start, db = b.c.end - b.c.start;
        return db > da + EPS || (Math.abs(db - da) <= EPS && b.lvl > a.lvl) ? b : a;
      });
      const e = Math.min(best.c.end, g1);
      out.push(trimTo(best.c, at, e));
      at = e;
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * 两段主要内容之间的转场:先认两段之间的交叉溶解,再认前一段的淡出、后一段的淡入。没有就是 null(缩略时间轴上画「＋」)。
 */
export function boundaryTransition(p: Project, a: TrackClip, b: TrackClip): Transition | null {
  const list = transitionsOf(p);
  return (
    list.find((tr) => tr.kind === "crossfade" && tr.aId === a.id && tr.bId === b.id) ??
    list.find((tr) => tr.kind === "fadeOut" && tr.aId === a.id) ??
    list.find((tr) => tr.kind === "fadeIn" && tr.aId === b.id) ??
    null
  );
}

/** 片段在界面上叫什么:显示名 → 素材名 → 剪辑名 → 卡片 id */
export function clipName(p: Project, clip: TrackClip, cardName?: (cardId: string) => string | undefined): string {
  if (clip.label) return clip.label;
  const m = mediaOf(p, clip);
  if (m) return m.name;
  if (clip.cutId) return p.cuts?.find((c) => c.id === clip.cutId)?.name ?? "剪辑段";
  return cardName?.(clip.cardId) ?? clip.cardId ?? "片段";
}

export interface ReorderPlan {
  /** 要挪的段和它的新起点(时长不变) */
  moves: { id: string; start: number }[];
}

/**
 * 主要内容换顺序:按新顺序依次排,保留原来每个位置之间的空档(第 k 段的新起点 = 原来第 k 个位置的起点 + 前面几段时长之差)。
 * 只算,不改;放不下(和主轨上别的段撞了)或有转场锁着(相对时间是转场的一部分,`kernel/transitions.ts`)时回 `{ error }`。
 */
export function planReorder(p: Project, order: string[]): ReorderPlan | { error: string } {
  const main = mainClipsOf(p);
  const byId = new Map(main.map((c) => [c.id, c]));
  if (order.length !== main.length || order.some((id) => !byId.has(id))) return { error: "主要内容变了，请重试。" };
  const moves: { id: string; start: number }[] = [];
  let shift = 0;
  order.forEach((id, k) => {
    const slot = main[k];
    const c = byId.get(id)!;
    const start = slot.start + shift;
    shift += (c.end - c.start) - (slot.end - slot.start);
    if (Math.abs(start - c.start) > 1e-6) moves.push({ id, start });
  });
  if (!moves.length) return { moves };
  if (moves.some((m) => timingLock(p, m.id))) return { error: "有转场的段要先删掉转场，才能换顺序。" };
  const track = mainTrackOf(p)!;
  // 补空档补进来的段(不在主轨上,或只取了一截)不参与换顺序:它们的位置是别的序列定的
  const real = new Map(track.clips.map((c) => [c.id, c] as const));
  if (moves.some(({ id }) => { const c = byId.get(id)!, r = real.get(id); return !r || Math.abs(r.start - c.start) > EPS || Math.abs(r.end - c.end) > EPS; }))
    return { error: "这几段不都在主轨上，在时间轴分页里调整位置。" };
  const moved = new Set(moves.map((m) => m.id));
  const companions = new Set(track.clips.filter((c) => c.soundEffect?.sourceClipId && moved.has(c.soundEffect.sourceClipId)).map((c) => c.id));
  const placed = track.clips
    .filter((c) => !companions.has(c.id))
    .map((c) => {
      const m = moves.find((x) => x.id === c.id);
      return m ? { start: m.start, end: m.start + (c.end - c.start) } : { start: c.start, end: c.end };
    })
    .sort((a, b) => a.start - b.start);
  if (placed.some((c, i) => c.start < -1e-6 || (i > 0 && c.start < placed[i - 1].end - 1e-6))) return { error: "主轨上放不下新的顺序。" };
  return { moves };
}

/** 主要内容的总时长(各段时长之和,缩略时间轴标题行写它) */
export function mainTotal(clips: TrackClip[]): number {
  return clips.reduce((s, c) => s + (c.end - c.start), 0);
}

/**
 * 缩略卡等宽:当前帧标记落在第 i 张卡内的比例 f,换成项目时间。落在两卡之间(转场标记处)取下一段开头。
 * `pos` 是标记在卡序列里的位置:整数部分是第几张卡,小数部分是卡内比例;超出末尾回最后一段的结尾。
 */
export function timeAtCardPos(clips: TrackClip[], pos: number): number {
  if (!clips.length) return 0;
  if (pos <= 0) return clips[0].start;
  const i = Math.floor(pos);
  if (i >= clips.length) return clips[clips.length - 1].end;
  const c = clips[i];
  return c.start + (pos - i) * (c.end - c.start);
}

/** 反过来:项目时间 → 卡序列里的位置。落在两段之间的空档里算下一段开头,落在最后一段之后算末尾 */
export function cardPosAtTime(clips: TrackClip[], t: number): number {
  if (!clips.length) return 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (t < c.start) return i;
    if (t < c.end - 1e-9) return i + (t - c.start) / Math.max(1e-6, c.end - c.start);
  }
  return clips.length;
}
