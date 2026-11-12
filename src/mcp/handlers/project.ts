import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { findClip } from "../../kernel/project";
import { cameraFor, clampFov, DEFAULT_FOV_DEG, MAX_FOV_DEG, MIN_FOV_DEG } from "../../kernel/space3d";
import { activeCutKind, effectiveCamera3dFov } from "../../kernel/camera.mjs";
import { mediaCardUrl } from "../../ai/mediaRef";
import { parkedCutsIndex } from "../../kernel/agentScopes.mjs";
import { getCard } from "../../kernel/registry";

/**
 * Fields accepted by `set_project_meta` correspond one-to-one with its inputSchema.properties in
 * `server/tools/project.mjs` (`server/test/creativity-gate.test.mjs` CR-2 verifies consistency
 * between both sides). 3D perspective goes through `set_camera3d`, and themes can also go through
 * `set_theme`; the 3D rendering route (`glRoute`) and creativity level (`creativity`) are changed
 * only in project settings; the Agent does not write them.
 */
export const SET_PROJECT_META_FIELDS = ["name", "width", "height", "fps", "duration", "themeId"] as const;

/** Unrecognized keys in parameters (in order of appearance) */
export function undeclaredProjectMetaKeys(args: unknown): string[] {
  if (args === undefined || args === null) return [];
  if (typeof args !== "object" || Array.isArray(args)) return ["(arguments are not an object)"];
  return Object.keys(args).filter((k) => !(SET_PROJECT_META_FIELDS as readonly string[]).includes(k));
}

export function projectMetaRejection(unknown: string[]): string {
  const creativity = unknown.includes("creativity")
    ? "Creativity level can only be changed by the user in project settings or the AI panel; the Agent cannot write it."
    : "";
  return `set_project_meta does not accept these fields: ${unknown.join(", ")}. This call was not executed at all, no field was written.` +
    ` It only accepts ${SET_PROJECT_META_FIELDS.join(", ")}. ${creativity}` +
    "Use set_camera3d for 3D perspective; change other project content with the matching tool, it cannot be written directly through set_project_meta.";
}


export const projectHandlers = {
  getProject: () => {
    const p = getState().project;
    // Put clip indexes of parked cuts first: tracks is only for the active cut; without it, if the
    // model wants to see what is in other cuts, it can only switch_cut
    const parkedCuts = parkedCutsIndex(p, { cardName: (id) => getCard(id)?.name });
    return {
      ...(parkedCuts ? { parkedCuts } : null),
      ...p,
      media: p.media.map(m => {
        if (m.transcript) {
          return {
            ...m,
            transcript: {
              engine: m.transcript.engine,
              model: m.transcript.model,
              language: m.transcript.language,
              createdAt: m.transcript.createdAt,
              segments: m.transcript.segments.length,
              hint: "Use get_transcript for the full transcript"
            }
          };
        }
        return m;
      })
    };
  },
  listMedia: () => {
    const p = getState().project;
    return p.media.map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      duration: m.duration,
      width: m.width,
      height: m.height,
      // Use cardUrl for references in cards. No longer provide url: for imported media, that is a private
      // editor address starting with blob:; if the model uses it to fill cards, it will only get a blank
      // screen (see src/ai/mediaRef.ts)
      cardUrl: mediaCardUrl(m),
      path: m.path,
      hasTranscript: !!m.transcript,
      transcriptSegments: m.transcript ? m.transcript.segments.length : 0
    }));
  },
  getSelection: () => {
    const state = getState();
    return { selection: { clipIds: [...state.selection] },
      items: state.selection.map((id) => {
        const hit = findClip(state.project, id);
        return hit ? { id, trackId: hit.track.id, clip: hit.clip } : { id, missing: true };
      }) };
  },
  /**
   * Total duration does not go through setProjectMeta: writing it directly into the project will be
   * changed back immediately by the timeline based on content end. It follows the manual truncation
   * path, using the same rule as when users manually shorten it (kernel/duration.ts).
   *
   * Only accepts fields declared in the `set_project_meta` schema (`SET_PROJECT_META_FIELDS`); if any
   * other keys are included, reject the entire call and write none of them. Previously, `...rest` was
   * passed as-is to `setProjectMeta`, allowing the Agent to modify arbitrary project fields (tracks,
   * media, creativity level...), violating "Agent cannot bypass tools to modify the project directly"
   * (`user-workflow.md` "Protection"). Both the page and the Agent server (ssr-host) run this same copy.
   */
  setProjectMeta: (args) => {
    const unknown = undeclaredProjectMetaKeys(args);
    if (unknown.length) throw new Error(projectMetaRejection(unknown));
    const { duration, ...rest } = args ?? {};
    if (Object.keys(rest).length) actions.setProjectMeta(rest);
    if (typeof duration === "number" && Number.isFinite(duration)) actions.setDurationManual(duration);
    return { ok: true, duration: getState().project.duration };
  },
  /**
   * Master switch for 3D. **Only accepts fov, not camera distance**: distance is derived from fov and
   * canvas height; if users were allowed to fill in distance, changing the aspect ratio would change
   * the perspective intensity (see the table in kernel/space3d.ts). When turning off, delete the
   * field entirely instead of setting it to 0: legacy projects do not have this field, and the saved
   * output must be identical to never having enabled 3D.
   */
  setCamera3d: (args) => {
    const hasFov = args?.fovDeg !== undefined && args.fovDeg !== null;
    /*
     * Directly throw for non-numbers, do not go through clampFov.
     * clampFov returns default 40 for NaN, so set_camera3d({fovDeg:"very strong"}) would get
     * "fovDeg clamped to 40 (allowed 5~120)": the Agent assumes the number it passed was out of bounds,
     * when in fact the **type** was wrong, so it will adjust the number instead of fixing the type.
     * In the same repository, framePatchFromArgs throws directly on non-numbers; both places should
     * follow one standard.
     */
    if (hasFov && (typeof args.fovDeg !== "number" || !Number.isFinite(args.fovDeg))) {
      throw new Error(`fovDeg must be a finite number (${MIN_FOV_DEG}~${MAX_FOV_DEG}), got ${JSON.stringify(args.fovDeg)}`);
    }
    const turnOff = args?.enabled === false;
    const is3dCut = activeCutKind(getState().project) === "3d";
    if (is3dCut) {
      if (turnOff) {
        throw new Error(
          "Cannot turn off 3D perspective on a 3D cut: perspective and depth occlusion are intrinsic to kind \"3d\". To produce a 2D cut from this 3D cut, use prerender_cut_to_2d.",
        );
      }
      if (!hasFov && args?.enabled !== true) {
        const cur = getState().project;
        const fovNow = effectiveCamera3dFov(cur);
        const camNow = cameraFor({ width: cur.width, height: cur.height }, fovNow);
        return {
          ok: true,
          enabled: true,
          cutKind: "3d",
          fovDeg: fovNow,
          cameraDistancePx: Math.round(camNow.distance),
          hint: "Active cut is a 3D cut (perspective is always on). Pass fovDeg to set this cut's default 3D camera FOV, or use add_camera / update_camera to animate camera pose and fovDeg over time.",
        };
      }
      const fov = clampFov(hasFov ? args.fovDeg : effectiveCamera3dFov(getState().project));
      actions.setCutMeta(undefined, { camera3dFov: fov });
      const cur = getState().project;
      const cam = cameraFor({ width: cur.width, height: cur.height }, fov);
      return {
        ok: true,
        enabled: true,
        cutKind: "3d",
        fovDeg: fov,
        ...(hasFov && fov !== args.fovDeg
          ? { clamped: `fovDeg was clamped to ${fov} (allowed ${MIN_FOV_DEG}~${MAX_FOV_DEG})` }
          : null),
        cameraDistancePx: Math.round(cam.distance),
        hint: "Updated this 3D cut's default camera FOV (used whenever no active camera clip on the camera lane overrides fovDeg). Check the result with see_frames.",
      };
    }
    if (turnOff) {
      /*
       * When turning off, save the adjusted fov aside. If not saved, "turn off to compare, then turn back
       * on" will silently revert to default 40: the user's tweak to 60 is lost, without any prompt.
       * Store it in a module variable outside the store: it should not enter the project file (saved
       * output must be identical to never having enabled 3D).
       */
      const remembered = getState().project.camera3dFov ?? getState().lastCamera3dFov ?? undefined;
      actions.setProjectMeta({ camera3dFov: undefined });
      actions.rememberCamera3dFov(remembered ?? null);
      return {
        ok: true,
        enabled: false,
        hint: `3D is off. rotateX/rotateY/translateZ on cards are kept, there is just no perspective anymore${remembered ? `; turning it back on (enabled:true) restores ${remembered}°` : ""}`,
      };
    }
    if (!hasFov && args?.enabled !== true) {
      const cur = getState().project;
      return {
        ok: true,
        enabled: !!cur.camera3dFov,
        fovDeg: cur.camera3dFov ?? null,
        hint: "Nothing was passed, this only reported the current state. To turn it on pass fovDeg (or enabled:true), to turn it off pass enabled:false",
      };
    }
    const fov = clampFov(hasFov ? args.fovDeg : (getState().project.camera3dFov ?? getState().lastCamera3dFov ?? DEFAULT_FOV_DEG));
    actions.setProjectMeta({ camera3dFov: fov });
    const cur = getState().project;
    const cam = cameraFor({ width: cur.width, height: cur.height }, fov);
    return {
      ok: true,
      enabled: true,
      fovDeg: fov,
      ...(hasFov && fov !== args.fovDeg
        ? { clamped: `fovDeg was clamped to ${fov} (allowed ${MIN_FOV_DEG}~${MAX_FOV_DEG})` }
        : null),
      cameraDistancePx: Math.round(cam.distance),
      hint: "set_position rotateX / rotateY / translateZ now use true perspective. After changing, check with see_frames: perspective strength can only be judged by eye, not computed",
    };
  },
  setTheme: (args) => { actions.setProjectMeta({ themeId: args.themeId }); return { ok: true }; },
} satisfies Partial<EditorApi>;
