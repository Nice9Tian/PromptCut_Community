/**
 * 剪辑段的声音(`kernel/cutSegments.ts` 文件头「声音怎么出」)与包络。
 *
 * 声音那边没有「嵌套的场景」可挂,所以按时间把被引用剪辑里出声的片段平移、裁到段的窗口里,
 * 拼成一份只给混音用的项目。每层剪辑段的淡入淡出写成包络(`cutEnv`),由 `opacityAt`
 * 和各个混音器(`audioPlan.mjs` 的 `gainCurve`、`server/bakery/mux-audio.mjs` 的 afade 链)乘上去。
 *
 * 纯 JS(.mjs):导出混音在服务端直接 import,不经 TS。和 `cutSegments.ts` 的存法同一口径。
 */

/** 和 cuts.ts 新剪辑的默认时长同一个数 */
import { clipSpeed } from "./clipTime.mjs";

const FALLBACK_CUT_DURATION = 30;
const MAX_DEPTH = 32;

/** 一层包络在 t 时刻的值:窗口外 0,窗口内 不透明度 × 淡入 × 淡出 */
export function envelopeAt(e, t, withOpacity = true) {
  if (t < e.start || t >= e.end) return 0;
  let a = withOpacity ? e.opacity ?? 1 : 1;
  const fin = e.fadeIn ?? 0;
  const fout = e.fadeOut ?? 0;
  if (fin > 0 && t < e.start + fin) a *= (t - e.start) / fin;
  if (fout > 0 && t > e.end - fout) a *= (e.end - t) / fout;
  return Math.max(0, Math.min(1, a));
}

const isSeg = (c) => typeof c?.cutId === "string" && c.cutId.length > 0;

function activeIdOf(p) {
  const cuts = Array.isArray(p?.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

/** 被引用剪辑的子项目(只给声音用,不记忆化);成环、悬空、太深返回 null */
function subOf(p, cutId) {
  if (!Array.isArray(p.cuts)) return null;
  const root = activeIdOf(p);
  const path = p.cutPath ?? (root ? [root] : []);
  if (path.includes(cutId) || path.length >= MAX_DEPTH) return null;
  const entry = p.cuts.find((c) => c.id === cutId);
  if (!entry) return null;
  let content;
  if (cutId === activeIdOf(p)) content = { tracks: p.tracks, duration: p.duration };
  else if (Array.isArray(entry.tracks)) content = { tracks: entry.tracks, duration: typeof entry.duration === "number" && entry.duration > 0 ? entry.duration : FALLBACK_CUT_DURATION };
  else return null;
  return {
    ...p, tracks: content.tracks, duration: content.duration, transitions: entry.transitions ?? [],
    activeCutId: cutId, cuts: p.cuts.map((c) => (c.id === cutId ? { id: c.id, name: c.name } : c)), cutPath: [...path, cutId],
  };
}

const memo = new WeakMap();

/**
 * 只给混音用的项目:激活剪辑里的每个剪辑段,换成被引用剪辑里的片段,平移到段的时间上、裁到段的窗口里;
 * 嵌套的剪辑段递归展开。展开出来的片段放在各自新的序列里(同一个剪辑段的不同子序列在时间上会重叠),
 * 序列 id、片段 id 都带上剪辑段的路径前缀,不和原有的撞。
 *
 * - 音量 = 子片段自己的音量 × 每一层剪辑段的音量(`audioVolume`);
 * - 静音:任何一层剪辑段静音、所在序列静音,展开出来的就静音;
 * - 淡入淡出:子片段自己的(按它原来的起止)和每一层剪辑段的,都写进 `cutEnv`(不带段的不透明度 —— 那是画面的);
 * - 裁掉的那一截:素材段与卡片段都把源时钟(`mediaOffset`;卡片段没写时取它节点的 timeOffset)往后挪同样多,
 *   和切分同一个口径;
 * - 被引用剪辑事后变短:窗口截到它的总时长为止,超出的部分没有声音。
 *
 * 没有剪辑段的项目原样返回同一个对象(老项目的混音一个字节不变)。
 */
export function audioProjectOf(p) {
  if (!(p?.tracks ?? []).some((tr) => (tr.clips ?? []).some(isSeg))) return p;
  const hit = memo.get(p);
  if (hit) return hit;
  const tracks = [];
  for (const tr of p.tracks) {
    const plain = tr.clips.filter((c) => !isSeg(c));
    tracks.push(plain.length === tr.clips.length ? tr : { ...tr, clips: plain });
    for (const seg of tr.clips) if (isSeg(seg)) tracks.push(...expand(p, seg, tr, [], []));
  }
  const out = { ...p, tracks };
  memo.set(p, out);
  return out;
}

function fadesOf(c, start, end) {
  return { start, end, ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}) };
}

function expand(p, seg, hostTrack, prefix, outer) {
  const sub = subOf(p, seg.cutId);
  if (!sub) return [];
  const offset = Math.max(0, seg.cutOffset ?? 0);
  const shift = seg.start - offset; // 子剪辑时间 τ ↔ 父时间 τ + shift
  const w0 = seg.start;
  const w1 = Math.min(seg.end, sub.duration + shift);
  if (!(w1 > w0)) return [];
  const envs = [...outer, fadesOf(seg, seg.start, seg.end)];
  const path = [...prefix, seg.id];
  const segVolume = seg.audioVolume ?? 1;
  const segMuted = !!seg.audioMuted || !!hostTrack.muted;
  const out = [];
  for (const child of sub.tracks) {
    if (child.hidden) continue;
    const clips = [];
    const nested = [];
    for (const c of child.clips) {
      const s = c.start + shift, e = c.end + shift;
      const a = Math.max(s, w0), b = Math.min(e, w1);
      if (!(b > a)) continue;
      if (isSeg(c)) {
        // 嵌套的剪辑段:先把它自己平移、裁到这一层的窗口(偏移跟着走),它自己按原起止的淡化写成包络,再递归
        const moved = {
          ...c, start: a, end: b, cutOffset: Math.max(0, c.cutOffset ?? 0) + (a - s), fadeIn: undefined, fadeOut: undefined,
          audioVolume: (c.audioVolume ?? 1) * segVolume, audioMuted: !!c.audioMuted || segMuted || !!child.muted,
        };
        nested.push(...expand(sub, moved, { ...child, muted: false }, path, [...envs, fadesOf(c, s, e)]));
        continue;
      }
      const trim = a - s;
      const nodeOffset = c.nodeId ? Number((sub.cardNodes ?? []).find((n) => n.id === c.nodeId)?.timeOffset) || 0 : 0;
      const sourceOffset = c.mediaId ? (c.mediaOffset ?? 0) : (c.mediaOffset ?? nodeOffset);
      clips.push({
        ...c,
        id: `${path.join("/")}/${c.id}`,
        start: a,
        end: b,
        // 截掉的那一截按片段速度推进素材起点(变速段本身不出原声,这里只为口径一致;缺省 1 逐位不变)
        ...(trim > 0 || c.mediaId ? { mediaOffset: sourceOffset + trim * clipSpeed(c) } : {}),
        fadeIn: undefined,
        fadeOut: undefined,
        audioVolume: (c.audioVolume ?? 1) * segVolume,
        ...(segMuted || child.muted ? { audioMuted: true } : {}),
        // 外层各段的包络、子片段自己按原起止的淡化、这一层的窗口(被引用剪辑变短时截到它的总时长)
        cutEnv: [...envs, fadesOf(c, s, e), { start: w0, end: w1 }],
        // cutId:原片段住在哪条剪辑里(卡片声音的身份与覆盖范围按原片段核,`cardAudioRendition.mjs`)
        cutOrigin: { clipId: c.id, segments: path, cutId: seg.cutId },
      });
    }
    if (clips.length) out.push({ ...child, id: `${path.join("/")}/${child.id}`, muted: false, clips });
    out.push(...nested);
  }
  return out;
}
