import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { describeTransition, transitionsOf, type TransitionKind } from "../../kernel/transitions";
import { timelineDigest } from "../tools/toolEcho";
import { listCuts, resolveCut } from "../../kernel/cuts";
import { parkedCutsIndex } from "../../kernel/agentScopes.mjs";
import { getCard } from "../../kernel/registry";
import { cutContent, activeCutIdOf } from "../../kernel/cutSegments";
import {
  activeCutKind,
  CAMERA_2D_KEYS,
  CAMERA_3D_KEYS,
  cutKindOf,
  defaultCamera2D,
  defaultCamera3D,
  type CutKind,
} from "../../kernel/camera.mjs";
import { removeCutGate } from "./cutSegments";

import { clipGuard, filterTools, pixelMapTools } from "../common";

const CAMERA_SHORTHAND_KEYS = ["x", "y", "z", "rx", "ry", "rz", "fovDeg", "zoom", "rotate"] as const;

function extractCameraParams(args: Record<string, unknown> | undefined): Record<string, number | string | null> | undefined {
  if (!args) return undefined;
  const out: Record<string, number | string | null> = {};
  let touched = false;
  if (args.params !== undefined) {
    if (typeof args.params !== "object" || args.params === null || Array.isArray(args.params)) {
      throw new Error("params must be an object mapping camera fields to numbers or expression strings");
    }
    for (const [k, v] of Object.entries(args.params as Record<string, unknown>)) {
      out[k] = v as number | string | null;
      touched = true;
    }
  }
  for (const k of CAMERA_SHORTHAND_KEYS) {
    if (args[k] !== undefined && !Object.hasOwn(out, k)) {
      out[k] = args[k] as number | string | null;
      touched = true;
    }
  }
  return touched ? out : undefined;
}

export const effectsHandlers = {
  listFilters: () => filterTools.listFilters(),
  createFilter: (args) => { const r = filterTools.createFilter(args); clipGuard.noteMutation(); return r; },
  updateFilter: (args) => { const r = filterTools.updateFilter(args); clipGuard.noteMutation(); return r; },
  removeFilter: (args) => { const r = filterTools.removeFilter(args); clipGuard.noteMutation(); return r; },
  applyFilter: (args) => { const r = filterTools.applyFilter(args); clipGuard.noteMutation(); return r; },
  listPixelMaps: () => pixelMapTools.listPixelMaps(),
  createPixelMap: (args) => { const r = pixelMapTools.createPixelMap(args); clipGuard.noteMutation(); return r; },
  updatePixelMap: (args) => { const r = pixelMapTools.updatePixelMap(args); clipGuard.noteMutation(); return r; },
  removePixelMap: (args) => { const r = pixelMapTools.removePixelMap(args); clipGuard.noteMutation(); return r; },
  applyPixelMap: (args) => { const r = pixelMapTools.applyPixelMap(args); clipGuard.noteMutation(); return r; },
  listMediaEffects: (args) => pixelMapTools.listMediaEffects(args),
  listTransitions: () => {
    const p = getState().project;
    return {
      ok: true,
      transitions: transitionsOf(p).map((tr) => ({ ...tr, describe: describeTransition(p, tr) })),
      hint: "A transition binds the clips it references into one group: their relative timing is locked, and changing duration alone, changing track or splitting any of them will be rejected. Moving the whole group is not restricted. To adjust one individually, run remove_transition first.",
    };
  },
  addTransition: (args) => {
    const kind = String(args.kind ?? "") as TransitionKind;
    if (!["crossfade", "fadeIn", "fadeOut"].includes(kind)) {
      throw new Error(`kind must be crossfade / fadeIn / fadeOut, received ${JSON.stringify(args.kind)}`);
    }
    const r = actions.addTransition({ kind, clipId: args.clipId, otherClipId: args.otherClipId, dur: args.dur });
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, transition: r.transition, describe: describeTransition(p, r.transition),
      group: [r.transition.aId, ...(r.transition.bId ? [r.transition.bId] : [])],
      note: "These segments are now bound into one group: their relative timing is locked (moving the whole group is still allowed). To adjust one individually, run remove_transition first.",
      timeline: timelineDigest(p),
    };
  },
  removeTransition: (args) => {
    const r = actions.removeTransition(String(args.transitionId ?? ""));
    if (!r.ok) throw new Error(r.error);
    clipGuard.noteMutation();
    return { ok: true, ...(r.note ? { note: r.note } : {}), timeline: timelineDigest(getState().project) };
  },
  /* ---------- Cuts (multiple timelines) ---------- */
  // Each cut includes reference relationships (referencedBy: which cuts and segments reference it;
  // references: which cuts the cut segments inside it reference). When cutId is provided,
  // additionally return an overview of that cut's timeline (ids, start, and end for each track and
  // clip): obtain the clip id to modify without user_interface_switch_cut, and after obtaining it,
  // update_clip / set_clip / get_clip / set_rect… can modify directly by clipId (see mcp/clipCut.ts)
  listCuts: (args) => {
    const p = getState().project;
    const out: Record<string, unknown> = {
      activeCutId: p.activeCutId,
      activeCutKind: activeCutKind(p),
      cuts: listCuts(p).map((c) => ({ ...c, kind: c.kind ?? "2d" })),
    };
    if (args?.cutId !== undefined) {
      const cut = resolveCut(p, { cutId: String(args.cutId) });
      const content = cutContent(p, cut.id);
      if (!content) throw new Error(`Cut "${cut.name}" (${cut.id}) has no readable content`);
      // The digest here is the content of another cut assembled using p; the "other cut" hint is
      // meaningless for it
      const { otherCuts: _drop, ...digest } = timelineDigest({ ...p, tracks: content.tracks, duration: content.duration });
      out.timeline = {
        cutId: cut.id,
        name: cut.name,
        kind: cutKindOf(cut),
        active: cut.id === activeCutIdOf(p),
        ...(cut.spaceWidth ? { spaceWidth: cut.spaceWidth } : null),
        ...(cut.spaceHeight ? { spaceHeight: cut.spaceHeight } : null),
        ...(cut.camera3dFov ? { camera3dFov: cut.camera3dFov } : null),
        cameras: cut.cameras ?? [],
        ...digest,
      };
    } else {
      // When no cut is specified, list clips from all parked cuts directly (with an upper limit):
      // once the model obtains clipId, it does not need to call user_interface_switch_cut just to
      // "look inside"
      const parkedCuts = parkedCutsIndex(p, { cardName: (id) => getCard(id)?.name });
      if (parkedCuts) out.parkedCuts = parkedCuts;
    }
    return out;
  },
  switchCut: (args) => {
    const cut = resolveCut(getState().project, args);
    actions.switchCut(cut.id);
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true, activeCutId: p.activeCutId, cuts: listCuts(p), timeline: timelineDigest(p),
      note: `Switched to "${cut.name}". Switching changes the shared active cut and flips every member's interface together; it is not needed when you only want to edit clips that already exist in another cut:` +
        " Pass the clipId (found in list_cuts' cutId parameter / get_project's parkedCuts) directly to update_clip etc. to edit in place; to see another cut's picture, use see_frames' cutId." +
        " The timeline above is now this cut's; the previously active one is parked, and the clips inside it can likewise be edited directly.",
    };
  },
  // Create only, do not switch (user decision, 2026-10-21): switching the active cut affects all
  // members' UIs; to switch, call user_interface_switch_cut separately
  addCut: (args) => {
    if (args?.kind !== undefined && args.kind !== "2d" && args.kind !== "3d") {
      throw new Error(`kind must be "2d" or "3d", received ${JSON.stringify(args.kind)}`);
    }
    const cut = actions.addCut(args?.name, {
      switchTo: false,
      kind: args?.kind,
      spaceWidth: args?.spaceWidth,
      spaceHeight: args?.spaceHeight,
      camera3dFov: args?.camera3dFov,
    });
    clipGuard.noteMutation();
    const p = getState().project;
    const kind = cutKindOf(cut);
    return {
      ok: true,
      cut: {
        id: cut.id,
        name: cut.name,
        kind,
        ...(cut.spaceWidth ? { spaceWidth: cut.spaceWidth } : null),
        ...(cut.spaceHeight ? { spaceHeight: cut.spaceHeight } : null),
        ...(cut.camera3dFov ? { camera3dFov: cut.camera3dFov } : null),
      },
      activeCutId: p.activeCutId,
      cuts: listCuts(p),
      note: `Created ${kind.toUpperCase()} cut "${cut.name}" (${cut.id}) without switching to it; the active cut is unchanged. To add track clips into it, run user_interface_switch_cut (or add camera clips directly by passing cutId to add_camera); or use add_cut_segment to place it into the current cut as a cut segment.`,
    };
  },
  setCutKind: (args) => {
    const kind = String(args?.kind ?? "") as CutKind;
    if (kind !== "2d" && kind !== "3d") {
      throw new Error(`kind must be "2d" or "3d", received ${JSON.stringify(args?.kind)}`);
    }
    const p0 = getState().project;
    const cut = args?.cutId ? resolveCut(p0, { cutId: String(args.cutId) }) : resolveCut(p0, { cutId: activeCutIdOf(p0) });
    actions.setCutKind(cut.id, kind);
    if (args?.spaceWidth !== undefined || args?.spaceHeight !== undefined || args?.camera3dFov !== undefined) {
      actions.setCutMeta(cut.id, {
        ...(args.spaceWidth !== undefined ? { spaceWidth: args.spaceWidth } : {}),
        ...(args.spaceHeight !== undefined ? { spaceHeight: args.spaceHeight } : {}),
        ...(args.camera3dFov !== undefined ? { camera3dFov: args.camera3dFov } : {}),
      });
    }
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true,
      cutId: cut.id,
      name: cut.name,
      kind,
      activeCutId: p.activeCutId,
      cuts: listCuts(p),
    };
  },
  prerenderCutTo2D: async (args) => {
    const p0 = getState().project;
    const sourceCut = args?.cutId ? resolveCut(p0, { cutId: String(args.cutId) }) : resolveCut(p0, { cutId: activeCutIdOf(p0) });
    const { cut, media, clip } = await actions.prerenderCutTo2D(sourceCut.id, { switchTo: false, name: args?.name });
    clipGuard.noteMutation();
    const p = getState().project;
    return {
      ok: true,
      sourceCutId: sourceCut.id,
      cut: { id: cut.id, name: cut.name, kind: "2d" as const },
      media: { id: media.id, name: media.name, cardUrl: media.url, duration: media.duration, width: media.width, height: media.height },
      clipId: clip.id,
      activeCutId: p.activeCutId,
      cuts: listCuts(p),
      note: `Pre-rendered 3D cut "${sourceCut.name}" into video asset "${media.name}" and placed it on Track 1 of new 2D cut "${cut.name}" (${cut.id}). The original 3D cut "${sourceCut.name}" (${sourceCut.id}) was kept untouched.`,
    };
  },
  listCameras: (args) => {
    const p = getState().project;
    const cut = args?.cutId ? resolveCut(p, { cutId: String(args.cutId) }) : resolveCut(p, { cutId: activeCutIdOf(p) });
    const kind = cutKindOf(cut);
    const { cameras } = actions.listCameras(cut.id);
    return {
      ok: true,
      cutId: cut.id,
      name: cut.name,
      kind,
      cutKind: kind,
      allowedParams: kind === "3d" ? [...CAMERA_3D_KEYS] : [...CAMERA_2D_KEYS],
      defaultPose: kind === "3d" ? defaultCamera3D(p, cut) : defaultCamera2D(),
      cameras,
    };
  },
  addCamera: (args) => {
    const p0 = getState().project;
    const cut = args?.cutId ? resolveCut(p0, { cutId: String(args.cutId) }) : resolveCut(p0, { cutId: activeCutIdOf(p0) });
    const params = extractCameraParams(args as unknown as Record<string, unknown>);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === null) throw new Error(`add_camera params.${k} cannot be null; omit unset fields or pass a number / expression string`);
      }
    }
    const camera = actions.addCamera(
      {
        name: args.name,
        row: args.row,
        start: args.start,
        end: args.end,
        enabled: args.enabled,
        params: (params ?? {}) as Record<string, number | string>,
      },
      cut.id,
    );
    clipGuard.noteMutation();
    return {
      ok: true,
      cutId: cut.id,
      kind: cutKindOf(cut),
      cameraId: camera.id,
      camera,
      cameras: actions.listCameras(cut.id).cameras,
    };
  },
  updateCamera: (args) => {
    const p0 = getState().project;
    const cut = args?.cutId ? resolveCut(p0, { cutId: String(args.cutId) }) : resolveCut(p0, { cutId: activeCutIdOf(p0) });
    const params = extractCameraParams(args as unknown as Record<string, unknown>);
    const camera = actions.updateCamera(
      String(args.cameraId),
      {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.row !== undefined ? { row: args.row } : {}),
        ...(args.start !== undefined ? { start: args.start } : {}),
        ...(args.end !== undefined ? { end: args.end } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(params !== undefined ? { params } : {}),
      },
      cut.id,
    );
    clipGuard.noteMutation();
    return {
      ok: true,
      cutId: cut.id,
      kind: cutKindOf(cut),
      cameraId: camera.id,
      camera,
      cameras: actions.listCameras(cut.id).cameras,
    };
  },
  removeCamera: (args) => {
    const p0 = getState().project;
    const cut = args?.cutId ? resolveCut(p0, { cutId: String(args.cutId) }) : resolveCut(p0, { cutId: activeCutIdOf(p0) });
    actions.removeCamera(String(args.cameraId), cut.id);
    clipGuard.noteMutation();
    return {
      ok: true,
      removed: String(args.cameraId),
      cutId: cut.id,
      cameras: actions.listCameras(cut.id).cameras,
    };
  },
  renameCut: (args) => {
    const cut = resolveCut(getState().project, { cutId: args.cutId });
    actions.renameCut(cut.id, args.name);
    return { ok: true, cuts: listCuts(getState().project) };
  },
  removeCut: (args) => {
    const p = getState().project;
    const cut = resolveCut(p, { cutId: args.cutId });
    // The gate follows the same logic as remove_clip: if it has content or is referenced by other cuts
    // (cut segments), it cannot be deleted in a single prompt; force + reason are required, and the
    // reason is echoed to the user
    const blocked = removeCutGate(cut.id, !!args.force, args.reason);
    if (blocked) throw new Error(blocked);
    const before = p.activeCutId;
    const { removedSegments } = actions.removeCut(cut.id);
    clipGuard.noteMutation();
    const q = getState().project;
    return {
      ok: true, removed: cut.id,
      ...(before === cut.id ? { switchedTo: q.activeCutId } : null),
      ...(args.reason ? { reason: args.reason } : null),
      ...(removedSegments.length ? { removedSegments } : null),
      cuts: listCuts(q),
    };
  },
} satisfies Partial<EditorApi>;
