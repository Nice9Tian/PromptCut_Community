/**
 * Pixel map library tools shared by MCP / editor. Mapping definitions are validated for safety by
 * kernel/pixelMap.mjs.
 */
import { findClip, newId, type Project } from "../../kernel/project";
import { normalizePixelMapDef, classifyPixelMap, type PixelMapDef, type ClipPixelMap } from "../../kernel/pixelMap.mjs";
import { lookHint } from "./toolEcho";

export interface PixelMapStore {
  getState(): { project: Project };
  actions: {
    addPixelMap(def: PixelMapDef, attach?: { clipId: string; pixelMap: ClipPixelMap }): void;
    updatePixelMap(id: string, def: PixelMapDef): void;
    removePixelMap(id: string): void;
    setClipPixelMap(clipId: string, pixelMap: ClipPixelMap | null): boolean;
  };
}

const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
export function pixelMapUsesOf(p: Project, id: string) {
  const out: { clipId: string; cut?: string }[] = [];
  for (const t of p.tracks) for (const c of t.clips) if (c.pixelMap?.id === id) out.push({ clipId: c.id });
  for (const cut of p.cuts ?? []) if (cut.id !== p.activeCutId) for (const t of cut.tracks ?? []) for (const c of t.clips) if (c.pixelMap?.id === id) out.push({ clipId: c.id, cut: cut.name });
  return out;
}

export function createPixelMapTools(store: PixelMapStore) {
  const project = () => store.getState().project;
  const findDef = (p: Project, id: unknown) => {
    const key = text(id);
    const f = (p.pixelMaps ?? []).find((x) => x.id === key);
    if (!f) throw new Error(`No ${key || "(no pixelMapId given)"} in the pixel map library. Existing: ${(p.pixelMaps ?? []).map((x) => `${x.id} "${x.name}"`).join(", ") || "(library is empty)"}`);
    return f;
  };
  const mediaClip = (p: Project, clipId: unknown) => {
    const hit = findClip(p, text(clipId));
    if (!hit) throw new Error(`The current cut has no clip ${text(clipId) || "(no clipId given)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("Pixel maps attach only to video / image clips; for cards use their own params");
    const m = p.media.find((x) => x.id === hit.clip.mediaId);
    if (!m || m.kind === "audio") throw new Error("This segment has no picture, a pixel map cannot be attached");
    if (hit.track.locked) throw new Error(`The track "${hit.track.name}" containing this clip is locked; unlock it first`);
    return hit;
  };
  const media = (p: Project, mediaId: unknown, label: string) => {
    const id = text(mediaId);
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new Error(`${label} references a nonexistent asset ${id || "(empty)"}`);
    if (m.kind === "audio") throw new Error(`${label} cannot reference the audio-only asset "${m.name}"`);
    return m;
  };
  const validateMediaRefs = (p: Project, def: PixelMapDef) => {
    if (def.source.mediaId) media(p, def.source.mediaId, "source");
    if (def.to.kind === "media") media(p, def.to.mediaId, "to");
  };
  const summary = (p: Project, def: PixelMapDef) => ({ pixelMapId: def.id, name: def.name, description: def.description, source: def.source, where: def.where, to: def.to, mode: def.mode, colorSequence: def.colorSequence, usedBy: pixelMapUsesOf(p, def.id) });
  /*
   * Actively screen before storing into the library
   * (docs/archive/restructure_planning/render_pipeline_restructure.md 3.9). Whole-frame color grading
   * (A) is rejected: it can be handled by GPU compositor filters without consuming the preview
   * per-tick budget; pixel-by-pixel CPU implementation benchmarked at 416~483 ms per frame at 1080p,
   * so this tool is reserved only for tasks truly requiring pixel-by-pixel selection (B, via WebGL
   * backend). Explain clearly on the spot what cannot be translated (C). The tool response only has
   * a single message that can be delivered to the model, so equivalent ops are spliced directly into
   * the error body.
   */
  const gate = (def: PixelMapDef) => {
    const c = classifyPixelMap(def);
    if (c.kind === "A") {
      throw new Error(
        `This is whole-frame color grading, so a pixel map should not be used: ${c.reason}\n` +
        `Use create_filter instead. The ops below are pixel-for-pixel equivalent to your definition (max difference ${c.diff} levels over the full 0~255 range); copy them directly:\n` +
        `create_filter ${JSON.stringify({ name: def.name, ...(def.description ? { description: def.description } : null), ops: c.ops })}\n` +
        `Then use apply_filter to attach it to the clip.` +
        (c.alphaNote ? `\nNote: ${c.alphaNote}` : "") +
        `
(Filters are done by the compositor on the GPU and do not use the preview's per-tick budget; a pixel map runs its own WebGL fragment shader, computed per pixel, with one program compiled for each image.)`,
      );
    }
    if (c.kind === "C") throw new Error(`This definition cannot be translated into a shader: ${c.reason}`);
    return c;
  };
  return {
    listPixelMaps() {
      const p = project();
      return { ok: true, pixelMaps: (p.pixelMaps ?? []).map((x) => summary(p, x)), stages: ["origin", "after_filters"], modes: ["continuous", "discrete"], expression: "where/to.expr allow r g b a luma x y t; functions are the same as for ordinary filters; JavaScript is not executed" };
    },
    listMediaEffects(args: any = {}) {
      const p = project();
      const mediaId = text(args.mediaId);
      const clips = p.tracks.flatMap((t) => t.clips.filter((c) => !mediaId || c.mediaId === mediaId).map((c) => ({ clipId: c.id, trackId: t.id, mediaId: c.mediaId, start: c.start, end: c.end, filter: c.filter ?? null, pixelMap: c.pixelMap ?? null, audioFx: c.audioFx ?? null })));
      return { ok: true, ...(mediaId ? { mediaId } : {}), projectFilters: p.filters ?? [], projectPixelMaps: p.pixelMaps ?? [], projectAudioFx: p.audioFx ?? [], clips, note: "effects are returned in timeline connection order; stage=origin takes the original media, stage=after_filters takes the output after the corresponding filters" };
    },
    createPixelMap(args: any) {
      const base = normalizePixelMapDef(args);
      const def: PixelMapDef = { id: newId("pm"), ...base, createdBy: args?.createdBy === "user" ? "user" : "agent", createdAt: Date.now() };
      const cls = gate(def);
      validateMediaRefs(project(), def);
      let appliedTo: string | undefined;
      if (args?.clipId !== undefined) { const hit = mediaClip(project(), args.clipId); store.actions.addPixelMap(def, { clipId: hit.clip.id, pixelMap: { id: def.id } }); appliedTo = hit.clip.id; }
      else store.actions.addPixelMap(def);
      return { ok: true, pixelMapId: def.id, backend: cls.backend, pixelMap: summary(project(), def), ...(appliedTo ? { appliedTo, look: lookHint(appliedTo) } : null), note: "Created a general pixel map that processes by per-pixel selection (WebGL fragment shader). Preview, export and see_frames use the same definition; check the result with see_frames when done." };
    },
    updatePixelMap(args: any) {
      const cur = findDef(project(), args?.pixelMapId);
      const next = { ...normalizePixelMapDef({ ...cur, ...args }), id: cur.id, ...(cur.createdBy ? { createdBy: cur.createdBy } : null), ...(cur.createdAt ? { createdAt: cur.createdAt } : null) };
      const cls = gate(next);
      validateMediaRefs(project(), next);
      store.actions.updatePixelMap(cur.id, next);
      return { ok: true, backend: cls.backend, pixelMap: summary(project(), next), usedBy: pixelMapUsesOf(project(), cur.id) };
    },
    removePixelMap(args: any) {
      const p = project(); const cur = findDef(p, args?.pixelMapId); const uses = pixelMapUsesOf(p, cur.id);
      if (uses.length && !args?.force) throw new Error(`"${cur.name}" is still attached to ${uses.length} segments; detach it first, or pass force:true and state the reason in reason`);
      if (uses.length && args?.force && !text(args.reason)) throw new Error("A force delete must state the reason in reason; the user will see this sentence");
      store.actions.removePixelMap(cur.id);
      return { ok: true, removed: cur.id, name: cur.name, ...(uses.length ? { detached: uses, reason: text(args.reason) } : null) };
    },
    applyPixelMap(args: any) {
      const p = project(); const hit = mediaClip(p, args?.clipId); const id = text(args?.pixelMapId);
      if (!id) { if (!hit.clip.pixelMap) return { ok: true, clipId: hit.clip.id, note: "This segment had no pixel map attached in the first place" }; store.actions.setClipPixelMap(hit.clip.id, null); return { ok: true, clipId: hit.clip.id, removed: true }; }
      const def = findDef(p, id); store.actions.setClipPixelMap(hit.clip.id, { id: def.id });
      return { ok: true, clipId: hit.clip.id, pixelMapId: def.id, summary: summary(project(), def), look: lookHint(hit.clip.id), note: "Attached. If to is media, stage decides whether original pixels or post-filter pixels are taken." };
    },
  };
}
