import type { Project, Track, TrackClip } from "./project.ts";

/**
 * 转场 = 一条记录 + 它管着的那几段的淡化,并且**把这几段绑成一组**。
 *
 * 以前转场不是对象:两段重叠 + 各自淡化就算交叉溶解,谁都能随手把其中一段挪走,
 * 溶解就悄悄散了(fadeIn / fadeOut 还留在那儿,画面莫名其妙淡一下)。现在:
 *
 *   - 加转场 = 往 `project.transitions` 里放一条记录,并写好两端的 fadeIn / fadeOut;
 *   - 有记录的片段**相对时间关系被锁住**:不能单独挪、不能改长度、不能切开。整组
 *     一起平移是允许的(那不改相对关系);
 *   - 想单独调,先删转场 —— 删的时候把淡化清掉,并尽量把后一段挪回原位。
 *
 * 一段可以同时有淡入、淡出和跟前后段的交叉溶解;交叉溶解会把两段串成一组,
 * A—B—C 连着两处溶解就是一组三段(groupOf 走连通分量)。
 *
 * 这个文件是纯函数:只读 Project、返回结论,不碰 store,也不改任何东西。
 */
export type TransitionKind = "crossfade" | "fadeIn" | "fadeOut";

export interface Transition {
  id: string;
  kind: TransitionKind;
  /** 交叉溶解:前一段;淡入 / 淡出:那一段 */
  aId: string;
  /** 只有交叉溶解有:后一段 */
  bId?: string;
  /** 秒 */
  dur: number;
  /**
   * 交叉溶解为了造出重叠,会把后一段往前拉、必要时挪到另一条序列。
   * 这里记下它原来在哪,删转场时好放回去。
   */
  prevB?: { start: number; trackId: string };
}

export const MIN_TRANSITION_DUR = 0.1;
export const MAX_TRANSITION_DUR = 10;

export function transitionsOf(p: Project): Transition[] {
  return Array.isArray(p.transitions) ? p.transitions : [];
}

/** 引用到这个片段的全部转场 */
export function transitionsOfClip(p: Project, clipId: string): Transition[] {
  return transitionsOf(p).filter((tr) => tr.aId === clipId || tr.bId === clipId);
}

/** 这个片段身上某一侧的淡化是不是某条转场管着的(是的话不许手改) */
export function fadeOwner(p: Project, clipId: string, side: "fadeIn" | "fadeOut"): Transition | null {
  for (const tr of transitionsOf(p)) {
    if (tr.kind === "fadeIn" && side === "fadeIn" && tr.aId === clipId) return tr;
    if (tr.kind === "fadeOut" && side === "fadeOut" && tr.aId === clipId) return tr;
    if (tr.kind === "crossfade") {
      if (side === "fadeOut" && tr.aId === clipId) return tr;
      if (side === "fadeIn" && tr.bId === clipId) return tr;
    }
  }
  return null;
}

/**
 * 这个片段所在的组:靠交叉溶解一路串下去的所有片段(连通分量)。
 * 淡入 / 淡出不串别人,只锁自己那一段。片段不存在或没被任何转场引用时返回它自己一个。
 */
export function groupOf(p: Project, clipId: string): { members: string[]; transitions: Transition[] } {
  const all = transitionsOf(p);
  const members = new Set<string>([clipId]);
  const used = new Set<Transition>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const tr of all) {
      if (tr.kind !== "crossfade" || !tr.bId) continue;
      const hitA = members.has(tr.aId);
      const hitB = members.has(tr.bId);
      if (!hitA && !hitB) continue;
      if (!used.has(tr)) {
        used.add(tr);
        grew = true;
      }
      if (!hitA) { members.add(tr.aId); grew = true; }
      if (!hitB) { members.add(tr.bId); grew = true; }
    }
  }
  // 淡入淡出也算这一组的转场(它们锁的是同一批片段)
  for (const tr of all) {
    if (tr.kind !== "crossfade" && members.has(tr.aId)) used.add(tr);
  }
  return { members: [...members], transitions: [...used] };
}

function clipName(p: Project, clipId: string): string {
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (c.id !== clipId) continue;
      if (c.label) return c.label;
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
      return m?.name ?? c.cardId ?? clipId;
    }
  }
  return clipId;
}

const KIND_LABEL: Record<TransitionKind, string> = { crossfade: "crossfade", fadeIn: "Fade in", fadeOut: "Fade out" };

/**
 * 这个片段的时间关系被转场锁住了吗?锁住了就返回一句能直接回给 Agent 的说明。
 *
 * 「锁住」指的是**相对关系**:单独挪一段、改长度、切开都不行。整组一起平移不受影响
 * (store 的 moveClip 会把整组一起挪)。
 */
export function timingLock(p: Project, clipId: string): { transitions: Transition[]; members: string[]; message: string } | null {
  const hits = transitionsOfClip(p, clipId);
  if (hits.length === 0) return null;
  const { members } = groupOf(p, clipId);
  const parts = hits.map((tr) => {
    const who = tr.kind === "crossfade" ? `and "${clipName(p, tr.aId === clipId ? tr.bId! : tr.aId)}"` : "";
    return `${KIND_LABEL[tr.kind]}${who}(transitionId ${tr.id})`;
  });
  const others = members.filter((id) => id !== clipId);
  const groupNote = others.length ? `Others in this group: ${others.map((id) => `${clipName(p, id)}(${id})`).join(", ")}.` : "";
  return {
    transitions: hits,
    members,
    message:
      `This clip has transitions attached: ${parts.join(";")}. The transitions bind it with related clips into one group, so changing its time alone would break them. ${groupNote}` +
      `To change it, first call remove_transition({transitionId}). Shifting the whole group together is not restricted: move any one clip with update_clip and the rest of the group follows.`,
  };
}

function findClipIn(p: Project, clipId: string): { clip: TrackClip; track: Track } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

export function clampDur(dur: unknown, fallback = 0.5): number {
  const v = typeof dur === "number" && Number.isFinite(dur) ? dur : fallback;
  return Math.min(MAX_TRANSITION_DUR, Math.max(MIN_TRANSITION_DUR, v));
}

/** 加交叉溶解之前的体检。返回排好序的两段(a 在前),或者一句拒绝的理由 */
export function checkCrossfade(
  p: Project,
  aId: string,
  bId: string,
  dur: number,
): { ok: true; a: TrackClip; b: TrackClip; dur: number } | { ok: false; error: string } {
  if (aId === bId) return { ok: false, error: "A crossfade needs two different clips" };
  const A = findClipIn(p, aId);
  const B = findClipIn(p, bId);
  if (!A) return { ok: false, error: `Clip ${aId} not found` };
  if (!B) return { ok: false, error: `Clip ${bId} not found` };
  // 谁在前谁就是 a:参数顺序写反是常事,这里自己排,不劳 Agent 重来一次
  const [first, second] = A.clip.start <= B.clip.start ? [A, B] : [B, A];
  for (const hit of [first, second]) {
    const lock = transitionsOfClip(p, hit.clip.id).find((tr) => tr.kind === "crossfade");
    if (lock) {
      return { ok: false, error: `"${clipName(p, hit.clip.id)}" already has a crossfade (transitionId ${lock.id}); a clip can take part in at most one crossfade, so delete that one first` };
    }
  }
  const d = clampDur(dur);
  const shortest = Math.min(first.clip.end - first.clip.start, second.clip.end - second.clip.start);
  if (d >= shortest) {
    return { ok: false, error: `Transition of ${d}s is longer than one of the clips (shortest clip is ${shortest.toFixed(1)}s), use a shorter duration` };
  }
  // 必须首尾相接(或已经重叠):中间空着一大段的两个片段接不成转场
  const gap = second.clip.start - first.clip.end;
  if (gap > 0.001) {
    return { ok: false, error: `There is a ${gap.toFixed(1)}s gap between the two clips, and a crossfade can only join two clips that touch end to start. First move the later clip to the end of the earlier one` };
  }
  return { ok: true, a: first.clip, b: second.clip, dur: d };
}

/** 加淡入 / 淡出之前的体检 */
export function checkFade(
  p: Project,
  clipId: string,
  kind: "fadeIn" | "fadeOut",
  dur: number,
): { ok: true; clip: TrackClip; dur: number } | { ok: false; error: string } {
  const hit = findClipIn(p, clipId);
  if (!hit) return { ok: false, error: `Clip ${clipId} not found` };
  const already = transitionsOfClip(p, clipId).find((tr) => tr.kind === kind && tr.aId === clipId);
  if (already) return { ok: false, error: `This clip already has a ${KIND_LABEL[kind]} (transitionId ${already.id})` };
  // 淡入只能加在开头、淡出只能加在结尾 —— 这是它们的定义,不是可选项。
  // 已经参与交叉溶解的那一端不能再叠一个淡化:同一端两套淡化会互相打架。
  const owner = fadeOwner(p, clipId, kind);
  if (owner) {
    return { ok: false, error: `The ${kind === "fadeIn" ? "Start" : "end"} of this clip is already taken by a crossfade (transitionId ${owner.id}), so a ${KIND_LABEL[kind]} cannot be added` };
  }
  const d = clampDur(dur);
  const len = hit.clip.end - hit.clip.start;
  if (d >= len) return { ok: false, error: `${KIND_LABEL[kind]} of ${d}s is longer than the clip itself (${len.toFixed(1)}s)` };
  return { ok: true, clip: hit.clip, dur: d };
}

/**
 * 时间轴上把转场拖到某个位置,该加哪一种?
 *
 *   - 落在两段首尾相接的地方(接缝前后各 EDGE 秒内)→ 交叉溶解;
 *   - 落在一段的**开头** → 淡入;落在**结尾** → 淡出;
 *   - 落在中间 → 什么都不加(返回 null),界面据此显示「拖到片段两端或两段接缝处」。
 */
export function planTransitionDrop(
  p: Project,
  trackId: string,
  sec: number,
  edge = 0.6,
): { kind: TransitionKind; aId: string; bId?: string } | null {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const clips = [...track.clips].sort((x, y) => x.start - y.start);
  // 先看接缝:相接的两段,落点离接缝够近
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i];
    const b = clips[i + 1];
    if (Math.abs(b.start - a.end) > 0.001) continue;
    if (Math.abs(sec - a.end) <= edge) return { kind: "crossfade", aId: a.id, bId: b.id };
  }
  const inside = clips.find((c) => sec >= c.start - edge && sec <= c.end + edge);
  if (!inside) return null;
  const fromStart = sec - inside.start;
  const fromEnd = inside.end - sec;
  const near = Math.min(edge, (inside.end - inside.start) / 3);
  if (fromStart <= near) return { kind: "fadeIn", aId: inside.id };
  if (fromEnd <= near) return { kind: "fadeOut", aId: inside.id };
  return null;
}

/** 给界面看的一行说明 */
export function describeTransition(p: Project, tr: Transition): string {
  if (tr.kind === "crossfade") return `${clipName(p, tr.aId)} → ${clipName(p, tr.bId ?? "")} crossfade ${tr.dur.toFixed(1)}s`;
  return `${clipName(p, tr.aId)} ${KIND_LABEL[tr.kind]} ${tr.dur.toFixed(1)}s`;
}

export { KIND_LABEL as TRANSITION_LABEL };
