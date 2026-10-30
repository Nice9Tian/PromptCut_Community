/**
 * 项目文档里「序列在哪」的路径换算。
 *
 * 激活剪辑的序列住在 `/tracks`,停放的住在 `/cuts/@<剪辑>/tracks`(kernel/cuts.ts 的存法);
 * 切换剪辑(switch_cut、点标签)会把序列在两处之间搬来搬去。逆操作(撤销、「撤销这步」)记下的路径是**写入当时**的位置,
 * 到撤的时候序列可能已经搬走了:原样套用会因路径不存在落不下去,而且是静默的(线上 2026-10-21 验收018-复验2:
 * Agent switch_cut→改→switch_cut,之后撤那次改动毫无反应)。
 *
 * 这里按序列 id 找它**现在**住在哪,把路径改写过去:
 *   - `/tracks/@T/…`,T 现在在某条停放剪辑里 → `/cuts/@X/tracks/@T/…`;
 *   - `/cuts/@X/tracks/@T/…`,T 现在在激活剪辑(`/tracks`)里,或在别的剪辑里 → 改到那里;
 *   - 序列 id 找不到(真的被删了)、路径不经过序列、没有 cuts 的老项目 → 原样返回,由落不下去的老规矩处理。
 * 纯函数,不改入参。
 */
import { entityOfOp, entitiesOf, escapeSegment, parsePath, type PathOp } from "./diffProject.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasTrack = (tracks: unknown, id: string) => Array.isArray(tracks) && tracks.some((t) => isObj(t) && t.id === id);

/** 序列 T 现在住在哪:null 是激活剪辑(/tracks),字符串是停放剪辑的 id,undefined 是哪儿都没有 */
export function trackHome(project: unknown, trackId: string): string | null | undefined {
  if (!isObj(project)) return undefined;
  if (hasTrack(project.tracks, trackId)) return null;
  for (const c of Array.isArray(project.cuts) ? project.cuts : []) {
    if (isObj(c) && typeof c.id === "string" && hasTrack(c.tracks, trackId)) return c.id;
  }
  return undefined;
}

const seg = (s: string) => escapeSegment(s);

/** 一条路径换算到序列现在住的地方;不需要换算的原样返回 */
export function relocatePath(project: unknown, path: string): string {
  const segs = parsePath(path);
  if (!segs || segs.length === 0) return path;
  let rest: string[] | null = null;
  if (segs[0] === "tracks") rest = segs.slice(1);
  else if (segs[0] === "cuts" && segs[1]?.[0] === "@" && segs[2] === "tracks") rest = segs.slice(3);
  if (!rest) return path;
  const trackSeg = rest[0];
  // 只有指到某条序列(或它里面)的路径才换算;对 `/tracks` 数组本身的操作(插入新序列)不知道该进哪条剪辑,原样
  if (trackSeg === undefined || trackSeg[0] !== "@") return path;
  const home = trackHome(project, trackSeg.slice(1));
  if (home === undefined) return path;
  const prefix = home === null ? "/tracks" : `/cuts/@${seg(home)}/tracks`;
  return prefix + "/" + rest.map(seg).join("/");
}

/** 一串操作逐条换算路径(`move` / `insert` 这类带 path 的都一样处理) */
export function relocateOps(project: unknown, ops: readonly PathOp[]): PathOp[] {
  return ops.map((op) => {
    const path = relocatePath(project, op.path);
    return path === op.path ? op : { ...op, path };
  });
}

/**
 * 撤销冲突判断用的实体名:序列 / 片段不分它当时住在 `/tracks` 还是 `/cuts/@X/tracks`(搬家不是它的身份)——
 * `/cuts/@X/tracks/@T/clips/@C` 与 `/tracks/@T/clips/@C` 是同一个片段,别人在它停放时改的和激活时改的都算「后来改过」。
 * 规范里的实体名(`entityOfPath`,文档服务那边同一口径,通知 / 提交摘要用)不变,只有 docsync 的撤销冲突表走这里。
 */
export function undoEntity(entity: string): string {
  const m = /^\/cuts\/@[^/]+(\/tracks\/@.*)$/.exec(entity);
  return m ? m[1] : entity;
}

export function undoEntityOfOp(op: PathOp): string {
  return undoEntity(entityOfOp(op));
}

/** 一串操作写到的实体(撤销冲突口径),按首次出现的顺序去重 */
export function undoEntitiesOf(ops: readonly PathOp[]): string[] {
  return [...new Set(entitiesOf(ops).map(undoEntity))];
}
