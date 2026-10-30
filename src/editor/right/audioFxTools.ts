/**
 * 音频效果库的工具:list_audio_fx / create_audio_fx / update_audio_fx / remove_audio_fx / apply_audio_fx。
 * Agent(MCP)和素材库「音频效果」页、编辑页的效果那一栏共用这一份校验和门槛。
 *
 * 和 filterTools.ts 一个路数:效果是项目级的对象(project.audioFx),片段用 clip.audioFx 引用它 ——
 * 改效果,挂着它的片段全跟着变;同一个效果挂到哪一段都一样用,因为表达式里的 t 是片段内时间。
 * 数值在 kernel/audioFx.mjs,节点图在 src/audio/fxChain.ts(预览和导出同一份)。
 */

import { findClip, newId, type Project } from "../../kernel/project";
import {
  AUDIO_EXPR_HELP, AUDIO_FX_KINDS, AUDIO_FX_PRESETS, describeAudioFx, isAudioFxAnimated, normalizeAudioClipParams, normalizeAudioFxDef,
  type AudioFxDef, type ClipAudioFx,
} from "../../kernel/audioFx.mjs";

export interface AudioFxStore {
  getState(): { project: Project };
  actions: {
    addAudioFx(def: AudioFxDef, attach?: { clipId: string; fx: ClipAudioFx }): void;
    updateAudioFx(fxId: string, def: AudioFxDef): void;
    removeAudioFx(fxId: string): void;
    setClipAudioFx(clipId: string, fx: ClipAudioFx | null): boolean;
  };
}

/** 哪些片段挂着这个效果:激活剪辑的 + 停放剪辑里的(带剪辑名) */
export function audioFxUsesOf(p: Project, fxId: string): { clipId: string; cut?: string }[] {
  const out: { clipId: string; cut?: string }[] = [];
  for (const t of p.tracks) for (const c of t.clips) if (c.audioFx?.id === fxId) out.push({ clipId: c.id });
  for (const cut of p.cuts ?? []) {
    if (cut.id === p.activeCutId || !cut.tracks) continue;
    for (const t of cut.tracks) for (const c of t.clips) if (c.audioFx?.id === fxId) out.push({ clipId: c.id, cut: cut.name });
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function createAudioFxTools(store: AudioFxStore) {
  const project = () => store.getState().project;

  const summary = (p: Project, f: AudioFxDef) => ({
    fxId: f.id,
    name: f.name,
    ...(f.description ? { description: f.description } : null),
    ...(f.params ? { params: f.params } : null),
    ops: f.ops,
    summary: describeAudioFx(f),
    animated: isAudioFxAnimated(f),
    usedBy: audioFxUsesOf(p, f.id),
  });

  const findDef = (p: Project, fxId: unknown): AudioFxDef => {
    const id = str(fxId);
    const f = (p.audioFx ?? []).find((x) => x.id === id);
    if (!f) {
      const known = (p.audioFx ?? []).map((x) => `${x.id}「${x.name}」`).join("、") || "(效果库是空的)";
      throw new Error(`音频效果库里没有 ${id || "(没给 fxId)"}。现有:${known}`);
    }
    return f;
  };

  /** 能挂效果的片段:出声的素材段(视频 / 声音),序列没锁 */
  const soundClip = (p: Project, clipId: unknown) => {
    const id = str(clipId);
    const hit = id ? findClip(p, id) : null;
    if (!hit) throw new Error(`当前剪辑里没有片段 ${id || "(没给 clipId)"}`);
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error("音频效果只挂视频 / 声音片段;卡片没有声音");
    const media = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!media || media.kind === "image") throw new Error("这一段是图片,没有声音,挂不了音频效果");
    if (hit.track.locked) throw new Error(`这一段所在的序列「${hit.track.name}」锁定着,先解锁`);
    return hit;
  };

  return {
    listAudioFx() {
      const p = project();
      return {
        ok: true,
        effects: (p.audioFx ?? []).map((f) => summary(p, f)),
        kinds: Object.fromEntries(
          Object.entries(AUDIO_FX_KINDS).map(([k, s]) => [k, {
            label: s.label, hint: s.hint,
            params: Object.fromEntries(Object.entries(s.params).map(([pk, ps]) => [pk, { label: ps.label, default: ps.default, min: ps.min, max: ps.max, ...(ps.unit ? { unit: ps.unit } : null) }])),
          }]),
        ),
        presets: AUDIO_FX_PRESETS.map((x) => ({ name: x.name, description: x.description, ...(x.params ? { params: x.params } : null), ops: x.ops })),
        expressions: AUDIO_EXPR_HELP,
      };
    },

    /** 建一个放进库里;给了 clipId 就顺手挂上(先校验片段,不合规就什么都不建) */
    createAudioFx(args: any) {
      const base = normalizeAudioFxDef(args);
      const def: AudioFxDef = { id: newId("afx"), ...base, createdBy: args?.createdBy === "user" ? "user" : "agent", createdAt: Date.now() };
      let clipParams: Record<string, number> | undefined;
      if (args?.clipId !== undefined) {
        soundClip(project(), args.clipId);
        clipParams = normalizeAudioClipParams(def, args.clipParams);
      }
      // 入库和挂上是同一步(一步撤销)
      store.actions.addAudioFx(def, args?.clipId !== undefined ? { clipId: str(args.clipId), fx: { id: def.id, ...(clipParams ? { params: clipParams } : null) } } : undefined);
      return {
        ok: true,
        fxId: def.id,
        effect: summary(project(), def),
        note: "已放进素材库「音频效果」页,用户能看到、能复用",
        ...(args?.clipId !== undefined ? { appliedTo: str(args.clipId) } : null),
      };
    },

    /** 改库里的一条:没给的项沿用原来的,给了的整项替换;挂着它的片段全跟着变 */
    updateAudioFx(args: any) {
      const cur = findDef(project(), args?.fxId);
      const merged = normalizeAudioFxDef({
        name: args.name ?? cur.name,
        description: args.description ?? cur.description,
        params: args.params ?? cur.params,
        ops: args.ops ?? cur.ops,
      });
      const next: AudioFxDef = { ...merged, id: cur.id, ...(cur.createdBy ? { createdBy: cur.createdBy } : null), ...(cur.createdAt ? { createdAt: cur.createdAt } : null) };
      store.actions.updateAudioFx(cur.id, next);
      const p = project();
      const uses = audioFxUsesOf(p, cur.id);
      const declared = new Set(Object.keys(next.params ?? {}));
      const everywhere = [...p.tracks, ...(p.cuts ?? []).filter((c) => c.id !== p.activeCutId).flatMap((c) => c.tracks ?? [])].flatMap((t) => t.clips);
      const stale = everywhere.filter((c) => c.audioFx?.id === cur.id && Object.keys(c.audioFx.params ?? {}).some((k) => !declared.has(k)));
      return {
        ok: true,
        effect: summary(p, next),
        ...(uses.length ? { note: `挂着它的 ${uses.length} 段都跟着变了` } : null),
        ...(stale.length ? { warning: `${stale.map((c) => c.id).join("、")} 上覆盖的参数有些已经不在声明里了,不会生效;用 apply_audio_fx 重新给` } : null),
      };
    },

    /** 删:还挂着就要 force + reason(理由回显给用户),所有剪辑里的挂载一起摘掉 */
    removeAudioFx(args: any) {
      const p = project();
      const f = findDef(p, args?.fxId);
      const uses = audioFxUsesOf(p, f.id);
      const reason = str(args?.reason);
      if (uses.length && !args?.force) {
        throw new Error(
          `「${f.name}」还挂在 ${uses.length} 段上(${uses.map((u) => (u.cut ? `${u.cut} 的 ${u.clipId}` : u.clipId)).join("、")}),删了这些段的效果就没了。` +
            "确实要删就传 force:true 并在 reason 里写明理由;只想摘某一段用 apply_audio_fx 传空的 fxId",
        );
      }
      if (uses.length && args?.force && !reason) throw new Error("force 删除必须在 reason 里写明理由,用户会看到这句话");
      store.actions.removeAudioFx(f.id);
      return { ok: true, removed: f.id, name: f.name, ...(uses.length ? { detached: uses, reason } : null) };
    },

    /** 挂 / 换 / 摘(fxId 空 = 摘) */
    applyAudioFx(args: any) {
      const p = project();
      const hit = soundClip(p, args?.clipId);
      const clipId = hit.clip.id;
      const fid = str(args?.fxId);
      if (!fid) {
        if (!hit.clip.audioFx) return { ok: true, clipId, note: "这一段本来就没挂音频效果" };
        store.actions.setClipAudioFx(clipId, null);
        return { ok: true, clipId, removed: true };
      }
      const def = findDef(p, fid);
      const params = normalizeAudioClipParams(def, args?.params);
      store.actions.setClipAudioFx(clipId, { id: def.id, ...(params ? { params } : null) });
      return {
        ok: true,
        clipId,
        fxId: def.id,
        summary: describeAudioFx(def),
        ...(params ? { params } : null),
        ...(hit.clip.audioFx && hit.clip.audioFx.id !== def.id ? { note: "替换了这一段原来挂的效果(每段只挂一个;要叠多种就在一个效果里写多步 ops)" } : null),
        ...(hit.clip.audioMuted || hit.track.muted ? { warning: "这一段现在是静音的(片段 audioMuted 或序列 muted),效果挂上了但听不见" } : null),
      };
    },
  };
}
