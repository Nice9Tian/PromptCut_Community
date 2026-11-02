/**
 * Tools of the filter library: list_filters / create_filter / update_filter / remove_filter / apply_filter.
 * The Agent (MCP), the "Transitions / Filters" tab of the media library and the filter section of the
 * editing page share this one set of validation and gates.
 *
 * A filter is a project-level object (project.filters), and a clip references it with clip.filter: change
 * the filter and every clip using it changes along; the same filter works the same on any segment, because
 * t in the expression is the time within the clip. The values and the translation to the three composite
 * pipelines are in kernel/filters.mjs.
 */

import { findClip, newId, type Project } from "../../kernel/project";
import {
  describeFilter, EXPR_HELP, FILTER_KINDS, TABLE_KINDS, isAnimated, normalizeClipParams, normalizeFilterDef,
  type ClipFilter, type FilterDef,
} from "../../kernel/filters.mjs";
import { lookHint } from "../../mcp/tools/toolEcho";
import { tr } from "../../i18n/index.ts";

export interface FilterStore {
  getState(): { project: Project };
  actions: {
    addFilter(def: FilterDef, attach?: { clipId: string; filter: ClipFilter }): void;
    updateFilter(filterId: string, def: FilterDef): void;
    removeFilter(filterId: string): void;
    setClipFilter(clipId: string, filter: ClipFilter | null): boolean;
  };
}

/** Which clips use this filter: those in the active cut + those in parked cuts (with the cut name) */
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
      const known = (p.filters ?? []).map((x) => tr("{0}\"{1}\"", x.id, x.name)).join(tr(", ")) || tr("(filter library is empty)");
      throw new Error(tr("No {0} in the filter library. Available: {1}", id || tr("(filterId not given)"), known));
    }
    return f;
  };

  /** Clips a filter can be attached to: media clips with picture (video / image), on a track that is not locked */
  const mediaClip = (p: Project, clipId: unknown) => {
    const id = str(clipId);
    const hit = id ? findClip(p, id) : null;
    if (!hit) throw new Error(tr("The current cut has no clip {0}", id || tr("(no clipId given)")));
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error(tr("Filters attach only to video / image clips; cards use their own style parameters"));
    const media = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!media || media.kind === "audio") throw new Error(tr("This clip is audio with no picture, so a filter cannot be attached"));
    if (hit.track.locked) throw new Error(tr("The track \"{0}\" containing this clip is locked; unlock it first", hit.track.name));
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

    /** Create one and put it in the library; if clipId is given, attach it too (validate the clip first, and create nothing if it does not qualify) */
    createFilter(args: any) {
      const base = normalizeFilterDef(args);
      const def: FilterDef = { id: newId("fx"), ...base, createdBy: args?.createdBy === "user" ? "user" : "agent", createdAt: Date.now() };
      let clipParams: Record<string, number> | undefined;
      if (args?.clipId !== undefined) {
        mediaClip(project(), args.clipId);
        clipParams = normalizeClipParams(def, args.clipParams);
      }
      // Adding to the library and attaching are one step (one undo)
      store.actions.addFilter(def, args?.clipId !== undefined ? { clipId: str(args.clipId), filter: { id: def.id, ...(clipParams ? { params: clipParams } : null) } } : undefined);
      return {
        ok: true,
        filterId: def.id,
        filter: summary(project(), def),
        note: tr("Saved to the \"Transitions/Filters\" tab of the media library, where the user can see and reuse it"),
        ...(args?.clipId !== undefined ? { appliedTo: str(args.clipId), look: lookHint(str(args.clipId)) } : null),
      };
    },

    /** Edit one entry in the library: omitted fields keep their old values, given ones are replaced whole; clips attached to it all change with it */
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
      // If the parameter name overridden on a clip has been deleted, keeping it has no effect (evaluation only
      // recognizes declared ones), so mention it
      const declared = new Set(Object.keys(next.params ?? {}));
      const everywhere = [...p.tracks, ...(p.cuts ?? []).filter((c) => c.id !== p.activeCutId).flatMap((c) => c.tracks ?? [])].flatMap((t) => t.clips);
      const stale = everywhere.filter((c) => c.filter?.id === cur.id && Object.keys(c.filter.params ?? {}).some((k) => !declared.has(k)));
      return {
        ok: true,
        filter: summary(p, next),
        ...(uses.length ? { note: tr("The {0} clips using it have all changed with it", uses.length) } : null),
        ...(stale.length ? { warning: tr("Some parameters overridden on {0} are no longer declared and will not take effect; set them again with apply_filter", stale.map((c) => c.id).join(tr(", "))) } : null),
      };
    },

    /** Delete: if still attached, force + reason are required (the reason is echoed back to the user), and the attachments in all cuts are removed together */
    removeFilter(args: any) {
      const p = project();
      const f = findDef(p, args?.filterId);
      const uses = usesOf(p, f.id);
      const reason = str(args?.reason);
      if (uses.length && !args?.force) {
        throw new Error(
          tr("\"{0}\" is still attached to {1} clips ({2}); deleting it removes the effect from those clips.", f.name, uses.length, uses.map((u) => (u.cut ? tr("{1} of {0}", u.cut, u.clipId) : u.clipId)).join(tr(", "))) +
            tr("If you really want to delete it, pass force:true and give the reason in reason; to remove it from just one clip, call apply_filter with an empty filterId"),
        );
      }
      if (uses.length && args?.force && !reason) throw new Error(tr("A force delete must state the reason in reason; the user will see this sentence"));
      store.actions.removeFilter(f.id);
      return { ok: true, removed: f.id, name: f.name, ...(uses.length ? { detached: uses, reason } : null) };
    },

    /** Attach / swap / detach (empty filterId = detach) */
    applyFilter(args: any) {
      const p = project();
      const hit = mediaClip(p, args?.clipId);
      const clipId = hit.clip.id;
      const fid = str(args?.filterId);
      if (!fid) {
        if (!hit.clip.filter) return { ok: true, clipId, note: tr("This clip had no filter attached") };
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
        ...(hit.clip.filter && hit.clip.filter.id !== def.id ? { note: tr("Replaced the filter previously attached to this clip (one filter per clip)") } : null),
        look: lookHint(clipId),
      };
    },
  };
}
