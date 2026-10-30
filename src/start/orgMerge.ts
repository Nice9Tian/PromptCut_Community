/**
 * 云端分组的三方合并(裁定 V22-08:不是「后写的赢」,两台设备同时改时两边的改动都要留得住)。
 *
 * 什么时候用:`put` 回 409(云端那份比我上次拿到的新)。三份东西:
 *   - `base`   我上次从云端拿到的那一份(两边共同的出发点);没拿到过(第一次、缓存丢了)传 `null`,当成空的;
 *   - `mine`   我这边现在的(含还没传上去的改动);
 *   - `theirs` 409 带回来的云端当前那一份。
 * 合出一份新的,再带着 `theirs` 的版本号重传。
 *
 * 规则(分组、项目条目、对话条目一律按编号对齐,按字段合):
 *   - **字段**(名字、所属分组、置顶、归档):只我改过听我的,只对方改过听对方的,**两边都改了同一字段我这边的赢**;
 *   - **增**:并集;两边各自新增了同一个编号,字段整条听我的;
 *   - **删**:一边删、另一边**没改过**才算删;另一边在它之后改过的,留下(带着对方的改动),不让一次删除吞掉别人刚改的东西;
 *   - **顺序**:我这边动过顺序(只比较两边都在的那些条目的相对次序)就用我的;没动过就用对方的。
 *     另一边新增的条目插在它原来前一个邻居的后面(没有前一个邻居就放最前),所以「新建分组」仍在最后、「新出现的项目」仍在最前;
 *   - **连带**:对方删了某个分组而我把项目放进了它,项目回到「没放进分组」(和删分组的规矩一致)。
 * 同一个人在两台设备上同时改才会走到这里,不求花哨,求不丢东西。
 *
 * 纯函数,一律返回新对象,不原地改(仓库约束)。单测 `orgMerge.test.mjs`。
 */
import type { OrgChat, OrgGroup, OrgProject, OrgState } from "./vibeOrg.ts";

interface Spec<T> {
  key: (t: T) => string;
  /** 参与逐字段合并的字段,按 `eq` 比较 */
  fields: readonly (keyof T)[];
}

/** 比较用的值:标记(置顶、归档)没写和写了 false 是一回事;其它字段按值比,没有当 null */
const norm = (field: PropertyKey, v: unknown): unknown => (field === "pinned" || field === "archived" ? !!v : (v ?? null));

function fieldEq<T>(x: T, y: T, fields: readonly (keyof T)[]): boolean {
  return fields.every((f) => norm(f, x[f]) === norm(f, y[f]));
}

/** 合并两份「按编号对齐」的清单 */
export function mergeList<T>(base: readonly T[], mine: readonly T[], theirs: readonly T[], spec: Spec<T>): T[] {
  const { key, fields } = spec;
  const index = (list: readonly T[]) => new Map(list.map((t) => [key(t), t]));
  const b = index(base);
  const m = index(mine);
  const t = index(theirs);

  const merged = new Map<string, T>();
  for (const k of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const bi = b.get(k);
    const mi = m.get(k);
    const ti = t.get(k);
    if (!bi) {
      // 新增:两边都加了同编号就听我的;只一边加了就是它
      const pick = mi ?? ti;
      if (pick) merged.set(k, pick);
      continue;
    }
    if (!mi && !ti) continue; // 两边都删了
    if (!mi) {
      // 我删了:对方没改过才算删,改过的留下
      if (!fieldEq(bi, ti!, fields)) merged.set(k, ti!);
      continue;
    }
    if (!ti) {
      if (!fieldEq(bi, mi, fields)) merged.set(k, mi);
      continue;
    }
    // 两边都在:逐字段,只我改过的听我的,否则听对方的(两边都改了同一字段,「只我改过」也成立,所以我这边的赢)
    const out: T = { ...ti };
    for (const f of fields) {
      if (norm(f, bi[f]) !== norm(f, mi[f])) (out as Record<keyof T, unknown>)[f] = mi[f];
    }
    // 标记没记的字段保持没记:对方那份没有、我这份也没有,就不凭空写 false
    merged.set(k, cleanFlags(out));
  }

  // 顺序:我这边动过(两边都在的那些条目的相对次序变了)就用我的,否则用对方的
  const common = base.map(key).filter((k) => m.has(k));
  const mineOrder = mine.map(key).filter((k) => b.has(k));
  const baseOrder = common;
  const mineMoved = mineOrder.length !== baseOrder.length || mineOrder.some((k, i) => k !== baseOrder[i]);
  const primary = (mineMoved ? mine : theirs).map(key);
  const other = (mineMoved ? theirs : mine).map(key);

  const seq = primary.filter((k) => merged.has(k));
  const have = new Set(seq);
  // 另一边新增(或因「对方改过所以留下」而只在另一边有)的条目:插在它在那一边的前一个邻居后面
  other.forEach((k, i) => {
    if (have.has(k) || !merged.has(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = seq.indexOf(other[j]);
      if (prev >= 0) { at = prev + 1; break; }
    }
    seq.splice(at, 0, k);
    have.add(k);
  });
  // 两边的顺序里都没有的(只在 base 里被另一边保留的极端情形):补在最后,不丢
  for (const k of merged.keys()) if (!have.has(k)) seq.push(k);
  return seq.map((k) => merged.get(k)!);
}

/** 置顶、归档只写真的:`false` 和没写是一回事,存下去的一律不带 false,和 `vibeOrg.ts` 的 `flagsOf` 一致 */
function cleanFlags<T>(x: T): T {
  const r = { ...x } as Record<string, unknown>;
  if (r.pinned !== true) delete r.pinned;
  if (r.archived !== true) delete r.archived;
  return r as T;
}

const GROUP: Spec<OrgGroup> = { key: (g) => g.id, fields: ["name", "pinned", "archived"] };
const PROJECT: Spec<OrgProject> = { key: (p) => p.id, fields: ["groupId", "pinned", "archived"] };
const CHAT: Spec<OrgChat> = { key: (c) => `${c.projectId}\u0000${c.id}`, fields: ["pinned", "archived"] };

/** 合出一份云端整理信息。`base` 没有就当空的(两边的内容都算「新增」) */
export function mergeOrg(base: OrgState | null, mine: OrgState, theirs: OrgState): OrgState {
  const empty = { groups: [] as OrgGroup[], projects: [] as OrgProject[], chats: [] as OrgChat[] };
  const b = base ?? empty;
  const groups = mergeList(b.groups, mine.groups, theirs.groups, GROUP);
  const groupIds = new Set(groups.map((g) => g.id));
  const projects = mergeList(b.projects, mine.projects, theirs.projects, PROJECT)
    // 连带:所属分组被对方删了,项目回到没放进分组
    .map((p) => (p.groupId && !groupIds.has(p.groupId) ? { ...p, groupId: null } : p));
  const chats = mergeList(b.chats, mine.chats, theirs.chats, CHAT);
  return { v: 1, realm: theirs.realm, groups, projects, chats };
}
