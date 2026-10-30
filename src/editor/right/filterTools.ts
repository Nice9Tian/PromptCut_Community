/**
 * 滤镜库的工具:list_filters / create_filter / update_filter / remove_filter / apply_filter。
 * Agent(MCP)和素材库「转场/滤镜」页、编辑页的滤镜那一栏共用这一份校验和门槛。
 *
 * 滤镜是项目级的对象(project.filters),片段用 clip.filter 引用它 —— 改滤镜,挂着它的片段全跟着变;
 * 同一个滤镜挂到哪一段都一样用,因为表达式里的 t 是片段内时间。数值和三条合成管线的翻译在 kernel/filters.mjs。
 */

import { findClip, newId, type Project } from "../../kernel/project";
import {
  describeFilter, EXPR_HELP, FILTER_KINDS, TABLE_KINDS, isAnimated, normalizeClipParams, normalizeFilterDef,
  type ClipFilter, type FilterDef,
} from "../../kernel/filters.mjs";
import { lookHint } from "../../mcp/tools/toolEcho";

export interface FilterStore {
  getState(): { project: Project };
  actions: {
    addFilter(def: FilterDef, attach?: { clipId: string; filter: ClipFilter }): void;
    updateFilter(filterId: string, def: FilterDef): void;
    removeFilter(filterId: string): void;
    setClipFilter(clipId: string, filter: ClipFilter | null): boolean;
  };
}

/** 哪些片段挂着这个滤镜:激活剪辑的 + 停放剪辑里的(带剪辑名) */
export function usesOf(p: Project, filterId: string): { clipId: string; cut?: string }[] {
  const out: { clipId: string; cut?: string }[] = [];
  for (const t of p.tracks) for (const c of t.clips) if (c.filter?.id === filterId) out.push({ clipId: c.id });
  for (const cut of p.cuts ?? []) {
    if (cut.id === p.activeCutId || !cut.tracks) continue;
    for (const t of cut.tracks) for (const c of t.clips) if (c.filter?.id === filterId) out.push({ clipId: c.id, cut: cut.name });
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function createFilterTools(store: FilterStore) {
  const project = () => store.getState().project;

  const summary = (p: Project, f: FilterDef) => ({
    filterId: f.id,
    name: f.name,
    ...(f.description ? { description: f.description } : null),
    ...(f.params ? { params: f.params } : null),
    ops: f.ops,
    summary: describeFilter(f),
    animated: isAnimated(f),
    usedBy: usesOf(p, f.id),
  });

  const findDef = (p: Project, filterId: unknown): FilterDef => {
    const id = str(filterId);
    const f = (p.filters ?? []).find((x) => x.id === id);
    if (!f) {
      const known = (p.filters ?? []).map((x) => `${x.id}「${x.name}」`).join("、") || "(滤镜库是空的)";
      throw new Error(`滤镜库里没有 ${id || "(没给 filterId)"}。现有:${known}`);
    }
    return f;
  };

  /** 能挂滤镜的片段:有画面的素材段(视频 / 图片),序列没锁 */
  const mediaClip = (p: Project, clipId: unknown) => {
    const id = str(clipId);
    const hit = id ? findClip(p, id) : null;
    if (!hit) throw new Error(`当前剪辑里没有片段 ${id || "(没给 clipId)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("滤镜只挂视频 / 图片片段;卡片用自己的样式参数");
    const media = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!media || media.kind === "audio") throw new Error("这一段是声音,没有画面,挂不了滤镜");
    if (hit.track.locked) throw new Error(`这一段所在的序列「${hit.track.name}」锁定着,先解锁`);
    return hit;
  };

  return {
    listFilters() {
      const p = project();
      return {
        ok: true,
        filters: (p.filters ?? []).map((f) => summary(p, f)),
        kinds: Object.fromEntries(
          Object.entries(FILTER_KINDS).map(([k, s]) => [k, { label: s.label, min: s.min, max: s.max, neutral: s.neutral, hint: s.hint }]),
        ),
        tableKinds: Object.fromEntries(Object.entries(TABLE_KINDS).map(([k, s]) => [k, { label: s.label, hint: s.hint }])),
        expressions: EXPR_HELP,
      };
    },

    /** 建一个放进库里;给了 clipId 就顺手挂上(先校验片段,不合规就什么都不建) */
    createFilter(args: any) {
      const base = normalizeFilterDef(args);
      const def: FilterDef = { id: newId("fx"), ...base, createdBy: args?.createdBy === "user" ? "user" : "agent", createdAt: Date.now() };
      let clipParams: Record<string, number> | undefined;
      if (args?.clipId !== undefined) {
        mediaClip(project(), args.clipId);
        clipParams = normalizeClipParams(def, args.clipParams);
      }
      // 入库和挂上是同一步(一步撤销)
      store.actions.addFilter(def, args?.clipId !== undefined ? { clipId: str(args.clipId), filter: { id: def.id, ...(clipParams ? { params: clipParams } : null) } } : undefined);
      return {
        ok: true,
        filterId: def.id,
        filter: summary(project(), def),
        note: "已放进素材库「转场/滤镜」页,用户能看到、能复用",
        ...(args?.clipId !== undefined ? { appliedTo: str(args.clipId), look: lookHint(str(args.clipId)) } : null),
      };
    },

    /** 改库里的一条:没给的项沿用原来的,给了的整项替换;挂着它的片段全跟着变 */
    updateFilter(args: any) {
      const cur = findDef(project(), args?.filterId);
      const merged = normalizeFilterDef({
        name: args.name ?? cur.name,
        description: args.description ?? cur.description,
        params: args.params ?? cur.params,
        ops: args.ops ?? cur.ops,
      });
      const next: FilterDef = { ...merged, id: cur.id, ...(cur.createdBy ? { createdBy: cur.createdBy } : null), ...(cur.createdAt ? { createdAt: cur.createdAt } : null) };
      store.actions.updateFilter(cur.id, next);
      const p = project();
      const uses = usesOf(p, cur.id);
      // 片段上覆盖的参数名如果被删掉了,留着也不生效(求值只认声明过的),提一句
      const declared = new Set(Object.keys(next.params ?? {}));
      const everywhere = [...p.tracks, ...(p.cuts ?? []).filter((c) => c.id !== p.activeCutId).flatMap((c) => c.tracks ?? [])].flatMap((t) => t.clips);
      const stale = everywhere.filter((c) => c.filter?.id === cur.id && Object.keys(c.filter.params ?? {}).some((k) => !declared.has(k)));
      return {
        ok: true,
        filter: summary(p, next),
        ...(uses.length ? { note: `挂着它的 ${uses.length} 段都跟着变了` } : null),
        ...(stale.length ? { warning: `${stale.map((c) => c.id).join("、")} 上覆盖的参数有些已经不在声明里了,不会生效;用 apply_filter 重新给` } : null),
      };
    },

    /** 删:还挂着就要 force + reason(理由回显给用户),所有剪辑里的挂载一起摘掉 */
    removeFilter(args: any) {
      const p = project();
      const f = findDef(p, args?.filterId);
      const uses = usesOf(p, f.id);
      const reason = str(args?.reason);
      if (uses.length && !args?.force) {
        throw new Error(
          `「${f.name}」还挂在 ${uses.length} 段上(${uses.map((u) => (u.cut ? `${u.cut} 的 ${u.clipId}` : u.clipId)).join("、")}),删了这些段的效果就没了。` +
            "确实要删就传 force:true 并在 reason 里写明理由;只想摘某一段用 apply_filter 传空的 filterId",
        );
      }
      if (uses.length && args?.force && !reason) throw new Error("force 删除必须在 reason 里写明理由,用户会看到这句话");
      store.actions.removeFilter(f.id);
      return { ok: true, removed: f.id, name: f.name, ...(uses.length ? { detached: uses, reason } : null) };
    },

    /** 挂 / 换 / 摘(filterId 空 = 摘) */
    applyFilter(args: any) {
      const p = project();
      const hit = mediaClip(p, args?.clipId);
      const clipId = hit.clip.id;
      const fid = str(args?.filterId);
      if (!fid) {
        if (!hit.clip.filter) return { ok: true, clipId, note: "这一段本来就没挂滤镜" };
        store.actions.setClipFilter(clipId, null);
        return { ok: true, clipId, removed: true };
      }
      const def = findDef(p, fid);
      const params = normalizeClipParams(def, args?.params);
      store.actions.setClipFilter(clipId, { id: def.id, ...(params ? { params } : null) });
      return {
        ok: true,
        clipId,
        filterId: def.id,
        summary: describeFilter(def),
        ...(params ? { params } : null),
        ...(hit.clip.filter && hit.clip.filter.id !== def.id ? { note: "替换了这一段原来挂的滤镜(每段只挂一个)" } : null),
        look: lookHint(clipId),
      };
    },
  };
}
