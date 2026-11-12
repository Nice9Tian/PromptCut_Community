import {
  switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure, placeCutSegment, normalizeCuts,
  setCutKindInProject, setCutMetaInProject,
  listCamerasInCut, addCameraToCut, updateCameraInCut, removeCameraFromCut,
} from "../../kernel/cuts";
import { CUT_SEGMENT_REF_FIXED, cutCycleReason, cutDuration, cutReferences, isCutSegment } from "../../kernel/cutSegments";
import { cutKindOf, type CameraClip, type CutKind } from "../../kernel/camera.mjs";
import { findClip, newId, type Cut, type MediaAsset, type Track, type TrackClip } from "../../kernel/project";

import { state, set, setProject, updateTrack, runInCutScope } from "../core";
import { prerenderUrl } from "../../render/prerender";
import { tr } from "../../i18n/index.ts";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export const cuts = {

  /* ---------- Cuts (multiple timelines) ---------- */
  /**
   * Switch to another cut. Current tracks / duration / playhead are saved back to its entry, and the
   * target's are swapped in. Enters the undo stack (together with the entire project; undoing simply
   * switches back); selection is cleared, playback stops, and manual total duration is cleared: these
   * all belong to the previous cut. Playhead uses the target's position when last exited.
   */
  switchCut(cutId: string) {
    const { project, t } = switchCutPure(state.project, cutId, state.t);
    if (project === state.project) return;
    setProject(project);
    set({ t, playing: false, selection: [], selectedCameraId: null, playToken: state.playToken + 1, durationManual: null });
  },
  /** Create a new cut and switch to it by default (consistent with NLE conventions for creating a sequence) */
  addCut(
    name?: string,
    opts: { switchTo?: boolean; kind?: CutKind; spaceWidth?: number; spaceHeight?: number; camera3dFov?: number } = {},
  ) {
    const { project, cut } = addCutPure(state.project, name, {
      kind: opts.kind,
      spaceWidth: opts.spaceWidth,
      spaceHeight: opts.spaceHeight,
      camera3dFov: opts.camera3dFov,
    });
    setProject(project);
    if (opts.switchTo !== false) cuts.switchCut(cut.id);
    return cut;
  },
  renameCut(cutId: string, name: string) {
    setProject(renameCutPure(state.project, cutId, name));
  },
  /**
   * Delete a cut. Deleting the active cut switches to an adjacent one first; the last cut cannot be
   * deleted (throws in pure logic). When referenced by other cuts, cut segments referencing it are
   * deleted along with transitions (explanation and confirmation are caller responsibilities: media
   * library prompts confirmation, Agent tools require force). One-step undo restores everything.
   * Returns which cuts contain the deleted cut segments.
   */
  removeCut(cutId: string) {
    const { project, switchedTo, t, removedSegments } = removeCutPure(state.project, cutId, state.t);
    setProject(project);
    if (switchedTo) set({ t, playing: false, selection: [], selectedCameraId: null, playToken: state.playToken + 1, durationManual: null });
    else set({ selection: state.selection.filter((id) => !removedSegments.some((r) => r.clipIds.includes(id))) });
    return { removedSegments };
  },
  /** Switch a cut's kind (`"2d" -> "3d"` is lossless; `"3d" -> "2d"` requires `prerenderCutTo2D`) */
  setCutKind(cutId: string | undefined, kind: CutKind) {
    const next = setCutKindInProject(state.project, cutId, kind);
    if (next !== state.project) setProject(next);
  },
  /** Update cut-level metadata (`camera3dFov`, `spaceWidth`, `spaceHeight`) */
  setCutMeta(
    cutId: string | undefined,
    patch: { camera3dFov?: number | null; spaceWidth?: number | null; spaceHeight?: number | null },
  ) {
    const next = setCutMetaInProject(state.project, cutId, patch);
    if (next !== state.project) setProject(next);
  },
  /** List camera clips on a cut's dedicated camera lane (defaults to active cut) */
  listCameras(cutId?: string) {
    return listCamerasInCut(state.project, cutId);
  },
  /** Add a camera clip to a cut's camera lane (validates row non-overlap and `t`/`d`/`p` expressions) */
  addCamera(
    input: {
      id?: string;
      name?: string;
      row?: number;
      start: number;
      end: number;
      enabled?: boolean;
      params?: Record<string, number | string>;
    },
    cutId?: string,
  ): CameraClip {
    const { project, camera } = addCameraToCut(state.project, cutId, input);
    setProject(project);
    const activeId = project.activeCutId;
    if (!cutId || cutId === activeId) {
      set({ selectedCameraId: camera.id, selection: [] });
    }
    return camera;
  },
  /** Update a camera clip on a cut's camera lane (validates row non-overlap and `t`/`d`/`p` expressions) */
  updateCamera(
    cameraId: string,
    patch: {
      name?: string;
      row?: number;
      start?: number;
      end?: number;
      enabled?: boolean;
      params?: Record<string, number | string | null>;
    },
    cutId?: string,
  ): CameraClip {
    const { project, camera } = updateCameraInCut(state.project, cutId, cameraId, patch);
    setProject(project);
    return camera;
  },
  /** Remove a camera clip from a cut's camera lane */
  removeCamera(cameraId: string, cutId?: string) {
    const project = removeCameraFromCut(state.project, cutId, cameraId);
    setProject(project);
    if (state.selectedCameraId === cameraId) set({ selectedCameraId: null });
  },
  /**
   * Commit a pre-rendered 3D cut `.mp4` payload into `project.media` and create a new 2D cut
   * containing that video clip on Track 1, keeping the original 3D cut completely untouched.
   * Shared by the browser UI action and the server-replica executor (`ssr-host.mjs`).
   */
  applyPrerenderedCutTo2D(
    cutId: string | undefined,
    data: Record<string, unknown>,
    opts: { switchTo?: boolean; name?: string } = {},
  ): { cut: Cut; media: MediaAsset; clip: TrackClip } {
    const cur = normalizeCuts(state.project);
    const targetId = cutId || cur.activeCutId!;
    const target = (cur.cuts ?? []).find((c) => c.id === targetId);
    if (!target) throw new Error(tr("Cut not found {0}", targetId));
    if (cutKindOf(target) !== "3d") {
      throw new Error(tr("Cut \"{0}\" is already a 2D cut; only 3D cuts need pre-rendering to a 2D cut", target.name));
    }
    if (typeof data?.hash !== "string" || !data.hash) {
      throw new Error(tr("Pre-rendered 3D cut response is missing asset hash"));
    }
    const dur = Math.max(1 / Math.max(1, cur.fps || 30), Number(data.duration) || 1);
    const rawTiers = data.tiers as { original?: unknown; small?: unknown } | undefined;
    const tiers: MediaAsset["tiers"] =
      rawTiers && typeof rawTiers.original === "string"
        ? { original: rawTiers.original, ...(typeof rawTiers.small === "string" ? { small: rawTiers.small } : {}) }
        : typeof data.small === "string"
          ? { original: data.hash, small: data.small }
          : undefined;
    const sizeBytes = Number(data.bytes ?? data.size);
    const asset: MediaAsset = {
      id: newId("m"),
      name: String(data.name || `${target.name}-2d.mp4`),
      kind: "video",
      url: String(data.url || `/@media/${data.hash}`),
      hash: data.hash,
      ext: String(data.ext || "mp4"),
      ...(Number.isFinite(sizeBytes) && sizeBytes > 0 ? { size: sizeBytes } : {}),
      duration: dur,
      width: Number(data.width) || cur.width,
      height: Number(data.height) || cur.height,
      ...(typeof data.path === "string" ? { path: data.path } : {}),
      ...(tiers ? { tiers } : {}),
    };
    const cutName = (opts.name ?? "").trim() || `${target.name} (2D)`;
    const { project: withCut, cut } = addCutPure({ ...cur, media: [...cur.media, asset] }, cutName, { kind: "2d" });
    const videoClip: TrackClip = {
      id: newId("k"),
      cardId: "",
      mediaId: asset.id,
      start: 0,
      end: dur,
      label: asset.name,
      params: {},
    };
    const finalDuration = Math.max(1, dur);
    const updatedCut: Cut = {
      ...cut,
      duration: finalDuration,
      tracks: (cut.tracks ?? []).map((t, i) => (i === 0 ? { ...t, clips: [videoClip] } : t)),
    };
    const nextProject = {
      ...withCut,
      cuts: (withCut.cuts ?? []).map((c) => (c.id === cut.id ? updatedCut : c)),
    };
    setProject(nextProject);
    if (opts.switchTo !== false) cuts.switchCut(updatedCut.id);
    return { cut: updatedCut, media: asset, clip: videoClip };
  },
  /**
   * Pre-render a 3D cut into an `.mp4` video asset and create a new 2D cut containing that video clip
   * on Track 1, keeping the original 3D cut completely untouched.
   */
  async prerenderCutTo2D(
    cutId?: string,
    opts: { switchTo?: boolean; name?: string } = {},
  ): Promise<{ cut: Cut; media: MediaAsset; clip: TrackClip }> {
    if (ONLINE_BUILD) {
      throw new Error(tr("Pre-rendering a 3D cut to a 2D cut requires the desktop rendering service"));
    }
    const loadToken = state.projectLoadToken;
    const p0 = normalizeCuts(state.project);
    const targetId = cutId || p0.activeCutId!;
    const target = (p0.cuts ?? []).find((c) => c.id === targetId);
    if (!target) throw new Error(tr("Cut not found {0}", targetId));
    if (cutKindOf(target) !== "3d") {
      throw new Error(tr("Cut \"{0}\" is already a 2D cut; only 3D cuts need pre-rendering to a 2D cut", target.name));
    }
    const res = await fetch(await prerenderUrl("/api/vision/prerender-cut"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: p0, cutId: targetId, name: opts.name }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok || typeof data.hash !== "string") {
      throw new Error(data?.error || tr("Pre-rendering 3D cut failed (HTTP {0})", res.status));
    }
    if (state.projectLoadToken !== loadToken) {
      throw new Error(tr("Project changed while pre-rendering; aborted applying result"));
    }
    return cuts.applyPrerenderedCutTo2D(targetId, data, opts);
  },
  /**
   * Modify clips in a parked cut in place: actions inside fn are written as usual assuming "this cut
   * is active"; upon commit, only its entry is modified, leaving the active cut and activeCutId
   * untouched (no switching, without flipping anyone's UI). fn must be synchronous. See store/core.ts
   * `runInCutScope`.
   */
  editInCut<T>(cutId: string, fn: () => T): T {
    return runInCutScope(cutId, fn);
  },
  /** Cuts that directly reference this cut (shown to user prior to deletion) */
  cutReferences(cutId: string) {
    return cutReferences(state.project, cutId);
  },
  /** Whether placing cut `childCutId` into the active cut causes circular references; returns the reason if so */
  cutCycleReason(childCutId: string): string | null {
    const host = state.project.activeCutId;
    return host ? cutCycleReason(state.project, host, childCutId) : null;
  },
  /**
   * Places a cut segment referencing `childCutId` in the active cut (drag and drop, Agent tool).
   * If `newTrackIndex` is provided, creates a new track and places it there; circular references,
   * cut not found, or track cannot fit all throw, with human-readable error messages.
   * Default duration = remaining duration of the referenced cut (from offset onwards).
   */
  addCutSegment(childCutId: string, start: number, opts: { trackId?: string; newTrackIndex?: number; duration?: number; offset?: number } = {}): TrackClip {
    let p = state.project;
    let trackId = opts.trackId;
    if (opts.newTrackIndex !== undefined || (!trackId && !p.tracks.length)) {
      const track: Track = { id: newId("t"), name: tr("Track {0}", p.tracks.length + 1), clips: [] };
      const tracks = [...p.tracks];
      const at = Math.max(0, Math.min(tracks.length, opts.newTrackIndex ?? tracks.length));
      tracks.splice(at, 0, track);
      p = { ...p, tracks };
      trackId = track.id;
    } else if (!trackId) {
      // No track specified: pick the first one that is unlocked and unoccupied during this time
      const free = p.tracks.find((t) => !t.locked && !t.clips.some((c) => c.start < start + 0.05 && start < c.end));
      trackId = (free ?? p.tracks.find((t) => !t.locked))?.id;
    }
    const { project, clip } = placeCutSegment(p, childCutId, start, { trackId, duration: opts.duration, offset: opts.offset });
    setProject(project);
    set({ selection: [clip.id] });
    return clip;
  },
  /**
   * Changes which second of the referenced cut the cut segment starts from. Throws if the offset
   * exceeds the total duration of the referenced cut. Which cut is referenced cannot be changed
   * (user decision, 2026-10-21, `workflow/editing.md` "Cut segment properties"): to replace it,
   * delete this segment and place it again, so this action only accepts `cutOffset`, and the reference
   * cannot be changed elsewhere either. If the segment is too long after the change, the out point is
   * clamped to the remaining duration of the referenced cut (when creating or extending a cut segment,
   * it cannot exceed the referenced cut's total duration at that time).
   */
  setCutSegment(clipId: string, patch: { cutOffset?: number }): TrackClip {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || !isCutSegment(hit.clip)) throw new Error(tr("{0} is not a cut segment", clipId));
    if (hit.track.locked) throw new Error(tr("Track \"{0}\" is locked", hit.track.name));
    if (patch && Object.hasOwn(patch, "cutId")) throw new Error(CUT_SEGMENT_REF_FIXED);
    const cutId = hit.clip.cutId!;
    const offset = Math.max(0, patch.cutOffset ?? hit.clip.cutOffset ?? 0);
    const total = cutDuration(p, cutId);
    if (offset >= total) throw new Error(tr("Offset {0} s exceeds the total duration of the referenced cut, {1} s", offset, total));
    const { cutOffset: _o, ...rest } = hit.clip;
    const next: TrackClip = { ...rest, cutId, end: Math.min(hit.clip.end, hit.clip.start + (total - offset)), ...(offset > 0 ? { cutOffset: offset } : {}) };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? next : c)) })));
    return next;
  },
};
