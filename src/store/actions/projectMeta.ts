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
  /** 记住关三维之前用的视角(不落盘,换项目自动清)。见 EditorState.lastCamera3dFov */
  rememberCamera3dFov(fov: number | null) {
    set({ lastCamera3dFov: fov });
  },
  /**
   * 手动设总时长。比内容末尾短就是截断,记下手动值;等于或更长就回到跟内容走。
   * 规则见 kernel/duration.ts。
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
