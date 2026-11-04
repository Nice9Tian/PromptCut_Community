import { type Project } from "../../kernel/project";
import { contentEndOf, effectiveDuration, manualDurationFor } from "../../kernel/duration";

import { state, set, setProject } from "../core";

export const projectMeta = {
  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId" | "camera3dFov" | "glRoute" | "creativity">>) {
    setProject({ ...state.project, ...patch });
  },
  editCardProject(edit: (project: Project) => Project) {
    setProject(edit(state.project));
  },
  /**
   * Remembers the camera FOV before closing 3D (not persisted to disk, auto-cleared on project
   * switch). See EditorState.lastCamera3dFov
   */
  rememberCamera3dFov(fov: number | null) {
    set({ lastCamera3dFov: fov });
  },
  /**
   * Manually sets total duration. Shorter than the end of content means truncation, recording
   * the manual value; equal to or longer reverts to following content. Rules in kernel/duration.ts.
   */
  setDurationManual(sec: number) {
    const val = Math.max(1, sec);
    const end = contentEndOf(state.project.tracks);
    const manual = manualDurationFor(val, end);
    setProject({ ...state.project, duration: effectiveDuration(end, val, manual) });
    set({ durationManual: manual });
  },
  syncDuration(sec: number) {
    const val = Math.max(1, sec);
    if (Math.abs(val - state.project.duration) < 1e-6) return;
    setProject({ ...state.project, duration: val }, { undoable: false });
  },
};
