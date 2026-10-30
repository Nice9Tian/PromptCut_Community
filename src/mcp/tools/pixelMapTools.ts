/** MCP / 编辑器共用的像素映射库工具。映射定义由 kernel/pixelMap.mjs 做安全校验。 */
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
    if (!f) throw new Error(`像素映射库里没有 ${key || "(没给 pixelMapId)"}。现有:${(p.pixelMaps ?? []).map((x) => `${x.id}「${x.name}」`).join("、") || "(库是空的)"}`);
    return f;
  };
  const mediaClip = (p: Project, clipId: unknown) => {
    const hit = findClip(p, text(clipId));
    if (!hit) throw new Error(`当前剪辑里没有片段 ${text(clipId) || "(没给 clipId)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("像素映射只挂视频 / 图片片段;卡片请用自己的参数");
    const m = p.media.find((x) => x.id === hit.clip.mediaId);
    if (!m || m.kind === "audio") throw new Error("这一段没有画面,不能挂像素映射");
    if (hit.track.locked) throw new Error(`这一段所在的序列「${hit.track.name}」锁定着,先解锁`);
    return hit;
  };
  const media = (p: Project, mediaId: unknown, label: string) => {
    const id = text(mediaId);
    const m = p.media.find((x) => x.id === id);
    if (!m) throw new Error(`${label} 引用了不存在的素材 ${id || "(空)"}`);
    if (m.kind === "audio") throw new Error(`${label} 不能引用只有声音的素材「${m.name}」`);
    return m;
  };
  const validateMediaRefs = (p: Project, def: PixelMapDef) => {
    if (def.source.mediaId) media(p, def.source.mediaId, "source");
    if (def.to.kind === "media") media(p, def.to.mediaId, "to");
  };
  const summary = (p: Project, def: PixelMapDef) => ({ pixelMapId: def.id, name: def.name, description: def.description, source: def.source, where: def.where, to: def.to, mode: def.mode, colorSequence: def.colorSequence, usedBy: pixelMapUsesOf(p, def.id) });
  /*
   * 落库之前主动分流(docs/archive/restructure_planning/render_pipeline_restructure.md 3.9)。整帧调色(A)不接:它由 GPU 合成器
   * 做的滤镜就能完成,不占预览的每拍预算;逐像素的 CPU 实现实测 1080p 每帧 416~483 ms,
   * 所以这个工具只留给真的要逐像素选区的活(B,走 WebGL 后端)。翻译不了的(C)当场说清楚。
   * 工具的回包只剩一条 message 能带到模型那边,所以等价 ops 直接拼进错误正文。
   */
  const gate = (def: PixelMapDef) => {
    const c = classifyPixelMap(def);
    if (c.kind === "A") {
      throw new Error(
        `这是整帧调色,不该用像素映射:${c.reason}\n` +
        `改用 create_filter,下面这份 ops 和你写的定义逐像素等价(0~255 全值域最大差 ${c.diff} 级),直接照抄:\n` +
        `create_filter ${JSON.stringify({ name: def.name, ...(def.description ? { description: def.description } : null), ops: c.ops })}\n` +
        `再用 apply_filter 把它挂到片段上。` +
        (c.alphaNote ? `\n注意:${c.alphaNote}` : "") +
        `\n（滤镜由合成器在 GPU 上做、不占预览的每拍预算;像素映射走自己的 WebGL 片元着色器,逐像素算、每张图各编一个 program。）`,
      );
    }
    if (c.kind === "C") throw new Error(`这条定义翻译不成着色器:${c.reason}`);
    return c;
  };
  return {
    listPixelMaps() {
      const p = project();
      return { ok: true, pixelMaps: (p.pixelMaps ?? []).map((x) => summary(p, x)), stages: ["origin", "after_filters"], modes: ["continuous", "discrete"], expression: "where/to.expr 允许 r g b a luma x y t;函数与普通滤镜相同;不执行 JavaScript" };
    },
    listMediaEffects(args: any = {}) {
      const p = project();
      const mediaId = text(args.mediaId);
      const clips = p.tracks.flatMap((t) => t.clips.filter((c) => !mediaId || c.mediaId === mediaId).map((c) => ({ clipId: c.id, trackId: t.id, mediaId: c.mediaId, start: c.start, end: c.end, filter: c.filter ?? null, pixelMap: c.pixelMap ?? null, audioFx: c.audioFx ?? null })));
      return { ok: true, ...(mediaId ? { mediaId } : {}), projectFilters: p.filters ?? [], projectPixelMaps: p.pixelMaps ?? [], projectAudioFx: p.audioFx ?? [], clips, note: "effects 按时间轴连接顺序返回；stage=origin 取原始媒体，stage=after_filters 取对应滤镜后的输出" };
    },
    createPixelMap(args: any) {
      const base = normalizePixelMapDef(args);
      const def: PixelMapDef = { id: newId("pm"), ...base, createdBy: args?.createdBy === "user" ? "user" : "agent", createdAt: Date.now() };
      const cls = gate(def);
      validateMediaRefs(project(), def);
      let appliedTo: string | undefined;
      if (args?.clipId !== undefined) { const hit = mediaClip(project(), args.clipId); store.actions.addPixelMap(def, { clipId: hit.clip.id, pixelMap: { id: def.id } }); appliedTo = hit.clip.id; }
      else store.actions.addPixelMap(def);
      return { ok: true, pixelMapId: def.id, backend: cls.backend, pixelMap: summary(project(), def), ...(appliedTo ? { appliedTo, look: lookHint(appliedTo) } : null), note: "已创建通用像素映射,按逐像素选区处理(WebGL 片元着色器)。预览、导出和 see_frames 使用同一份定义;完成后用 see_frames 复核。" };
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
      if (uses.length && !args?.force) throw new Error(`「${cur.name}」还挂在 ${uses.length} 段上,请先摘掉或传 force:true 并在 reason 里写明理由`);
      if (uses.length && args?.force && !text(args.reason)) throw new Error("force 删除必须在 reason 里写明理由,用户会看到这句话");
      store.actions.removePixelMap(cur.id);
      return { ok: true, removed: cur.id, name: cur.name, ...(uses.length ? { detached: uses, reason: text(args.reason) } : null) };
    },
    applyPixelMap(args: any) {
      const p = project(); const hit = mediaClip(p, args?.clipId); const id = text(args?.pixelMapId);
      if (!id) { if (!hit.clip.pixelMap) return { ok: true, clipId: hit.clip.id, note: "这一段本来就没挂像素映射" }; store.actions.setClipPixelMap(hit.clip.id, null); return { ok: true, clipId: hit.clip.id, removed: true }; }
      const def = findDef(p, id); store.actions.setClipPixelMap(hit.clip.id, { id: def.id });
      return { ok: true, clipId: hit.clip.id, pixelMapId: def.id, summary: summary(project(), def), look: lookHint(hit.clip.id), note: "已挂载。若 to 是媒体,stage 决定取原始像素或滤镜后的像素。" };
    },
  };
}
