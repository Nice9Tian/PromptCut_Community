/**
 * 别人(另一个页面、Agent 服务端)的改动落到本页面之后,本页面自己的页面状态要跟着调的那几处。
 *
 * c65-integ2 裁定:`set_project_meta`、`switch_cut`、`add_cut`、`remove_cut` 的写入改在 Agent 服务端执行
 * (D1 判据),页面状态只经页面通道只读地要一次(播放头)。它们原来顺手做的页面状态的「写」——
 * 切剪辑后换播放头、清选区、停播,截断总时长后记下手动值 —— 改由页面看到远端改动时自己推出来。
 * 这样本机两页、成员之间也一样:谁切了剪辑、截断了总时长,别的页面都跟上,而不是被时间轴按内容末尾改回去。
 *
 * 纯函数,不碰 store(`bindStore` 调它再 `set`),好在 node 里测。
 */
import type { Project } from "../kernel/project";
import { contentEndOf, manualDurationFor } from "../kernel/duration";

export interface RemotePageStateInput {
  t: number;
  selection: string[];
  durationManual: number | null;
  playToken: number;
}

export interface RemotePageStatePatch {
  t?: number;
  playing?: boolean;
  selection?: string[];
  playToken?: number;
  durationManual?: number | null;
}

function clipIds(p: Project): Set<string> {
  const ids = new Set<string>();
  for (const tr of p.tracks ?? []) for (const c of tr.clips ?? []) ids.add(c.id);
  return ids;
}

/**
 * `prev` 是应用远端改动之前本页面的项目,`next` 是之后的。回要写进 store 的页面状态,不用改时回 null。
 *
 * - 激活的剪辑变了(别人切了剪辑):和本页面自己切剪辑一样 —— 播放头换成目标剪辑上次停放时的(`prev` 里
 *   目标剪辑条目上的 `t`,切过去之后条目上就没有了),停播、清选区、总时长手动值清掉。
 * - 否则总时长变了(别人设了总时长、或别人的时间轴按内容末尾同步了):手动值按新的总时长推 ——
 *   比内容末尾短就是截断(记下),否则跟着内容走(清掉)。与 `setDurationManual` 同一条规则。
 * - 选区里已被删掉的片段摘掉。
 */
export function pageStateAfterRemote(prev: Project, next: Project, st: RemotePageStateInput): RemotePageStatePatch | null {
  if (prev === next) return null;
  const prevCut = prev.activeCutId ?? null;
  const nextCut = next.activeCutId ?? null;
  if (prevCut !== nextCut && nextCut !== null) {
    const parked = prev.cuts?.find((c) => c.id === nextCut)?.t;
    return {
      t: typeof parked === "number" && Number.isFinite(parked) ? parked : 0,
      playing: false,
      selection: [],
      playToken: st.playToken + 1,
      durationManual: null,
    };
  }
  const patch: RemotePageStatePatch = {};
  if (prev.duration !== next.duration) {
    const manual = manualDurationFor(next.duration, contentEndOf(next.tracks ?? []));
    if (manual !== st.durationManual) patch.durationManual = manual;
  }
  if (st.selection.length && prev.tracks !== next.tracks) {
    const alive = clipIds(next);
    const kept = st.selection.filter((id) => alive.has(id));
    if (kept.length !== st.selection.length) patch.selection = kept;
  }
  return Object.keys(patch).length ? patch : null;
}
