/**
 * Tools for the audio effects library: list_audio_fx / create_audio_fx / update_audio_fx /
 * remove_audio_fx / apply_audio_fx.
 * The Agent (MCP), the media library "Audio effects" tab and the effects column of the editor page
 * share this one set of validation and gates.
 *
 * Same approach as filterTools.ts: an effect is a project-level object (project.audioFx), and clips
 * reference it through clip.audioFx. Change the effect and every clip attached to it changes too;
 * the same effect works the same on any clip, because t in the expression is the time within the
 * clip. The values are in kernel/audioFx.mjs, and the node graph is in src/audio/fxChain.ts
 * (preview and export use the same one).
 */

import { findClip, newId, type Project } from "../../kernel/project";
import {
  AUDIO_EXPR_HELP, AUDIO_FX_KINDS, AUDIO_FX_PRESETS, describeAudioFx, isAudioFxAnimated, normalizeAudioClipParams, normalizeAudioFxDef,
  type AudioFxDef, type ClipAudioFx,
} from "../../kernel/audioFx.mjs";
import { tr } from "../../i18n/index.ts";

export interface AudioFxStore {
  getState(): { project: Project };
  actions: {
    addAudioFx(def: AudioFxDef, attach?: { clipId: string; fx: ClipAudioFx }): void;
    updateAudioFx(fxId: string, def: AudioFxDef): void;
    removeAudioFx(fxId: string): void;
    setClipAudioFx(clipId: string, fx: ClipAudioFx | null): boolean;
  };
}

/** Which clips have this effect attached: those in the active cut + those in parked cuts (with the cut name) */
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
      const known = (p.audioFx ?? []).map((x) => tr("{0}\"{1}\"", x.id, x.name)).join(tr(", ")) || tr("(effects library is empty)");
      throw new Error(tr("The audio effects library has no {0}. Available: {1}", id || tr("(no fxId given)"), known));
    }
    return f;
  };

  /** Clips that can take an effect: media clips that produce sound (video / audio), on an unlocked track */
  const soundClip = (p: Project, clipId: unknown) => {
    const id = str(clipId);
    const hit = id ? findClip(p, id) : null;
    if (!hit) throw new Error(tr("The current cut has no clip {0}", id || tr("(no clipId given)")));
    if (!hit.clip.mediaId || hit.clip.cardId) throw new Error(tr("Audio effects can only be attached to video / sound clips; card clips have no sound"));
    const media = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!media || media.kind === "image") throw new Error(tr("This clip is an image with no sound, so an audio effect cannot be attached"));
    if (hit.track.locked) throw new Error(tr("The track \"{0}\" containing this clip is locked; unlock it first", hit.track.name));
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

    /** Create one and put it in the library; if clipId is given, attach it too (validate the clip first, and create nothing if it does not qualify) */
    createAudioFx(args: any) {
      const base = normalizeAudioFxDef(args);
      const def: AudioFxDef = { id: newId("afx"), ...base, createdBy: args?.createdBy === "user" ? "user" : "agent", createdAt: Date.now() };
      let clipParams: Record<string, number> | undefined;
      if (args?.clipId !== undefined) {
        soundClip(project(), args.clipId);
        clipParams = normalizeAudioClipParams(def, args.clipParams);
      }
      // Adding to the library and attaching are one step (one undo)
      store.actions.addAudioFx(def, args?.clipId !== undefined ? { clipId: str(args.clipId), fx: { id: def.id, ...(clipParams ? { params: clipParams } : null) } } : undefined);
      return {
        ok: true,
        fxId: def.id,
        effect: summary(project(), def),
        note: tr("Added to the \"Audio effects\" tab of the media library, where the user can see and reuse it"),
        ...(args?.clipId !== undefined ? { appliedTo: str(args.clipId) } : null),
      };
    },

    /** Edit one entry in the library: omitted fields keep their old values, given ones are replaced whole; clips attached to it all change with it */
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
        ...(uses.length ? { note: tr("The {0} clips using it have all changed with it", uses.length) } : null),
        ...(stale.length ? { warning: tr("Some parameters overridden on {0} are no longer in the declaration and will not take effect; reassign with apply_audio_fx", stale.map((c) => c.id).join(tr(", "))) } : null),
      };
    },

    /** Delete: if still attached, force + reason are required (the reason is echoed back to the user), and the attachments in all cuts are removed together */
    removeAudioFx(args: any) {
      const p = project();
      const f = findDef(p, args?.fxId);
      const uses = audioFxUsesOf(p, f.id);
      const reason = str(args?.reason);
      if (uses.length && !args?.force) {
        throw new Error(
          tr("\"{0}\" is still attached to {1} clips ({2}); deleting it removes the effect from those clips.", f.name, uses.length, uses.map((u) => (u.cut ? tr("{1} of {0}", u.cut, u.clipId) : u.clipId)).join(tr(", "))) +
            tr("If you really want to delete it, pass force:true and state the reason in reason; to detach it from a single clip only, call apply_audio_fx with an empty fxId"),
        );
      }
      if (uses.length && args?.force && !reason) throw new Error(tr("A force delete must state the reason in reason; the user will see this sentence"));
      store.actions.removeAudioFx(f.id);
      return { ok: true, removed: f.id, name: f.name, ...(uses.length ? { detached: uses, reason } : null) };
    },

    /** Attach / swap / detach (empty fxId = detach) */
    applyAudioFx(args: any) {
      const p = project();
      const hit = soundClip(p, args?.clipId);
      const clipId = hit.clip.id;
      const fid = str(args?.fxId);
      if (!fid) {
        if (!hit.clip.audioFx) return { ok: true, clipId, note: tr("This clip had no audio effect attached to begin with") };
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
        ...(hit.clip.audioFx && hit.clip.audioFx.id !== def.id ? { note: tr("Replaced the effect previously attached to this clip (only one per clip; to stack several, write multi-step ops in one effect)") } : null),
        ...(hit.clip.audioMuted || hit.track.muted ? { warning: tr("This clip is currently muted (clip audioMuted or track muted); the effect is attached but inaudible") } : null),
      };
    },
  };
}
