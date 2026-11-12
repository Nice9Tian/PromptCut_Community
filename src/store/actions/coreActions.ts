import { createEmptyProject, newProjectId, type Project } from "../../kernel/project";
import { normalizeCuts } from "../../kernel/cuts";

import { state, history, future, set, getProjectSync, getProjectLoader } from "../core";

export const coreActions = {
  /* ---------- Document ---------- */
  loadProject(p: Project, filePath: string | null = null) {
    history.length = 0;
    future.length = 0;
    // Sole entry point for all load paths, where projects are normalized into multi-cut shape: old
    // files without cuts are padded to the default three. Also secures identity: custom card ownership
    // recognizes project.id, which projects from any entry path must have (see Project.id)
    const normalized = normalizeCuts(p.id ? p : { ...p, id: newProjectId() });
    // When connected to document service, loading is a root replacement (docsync handles commit and
    // clears its own undo stack)
    const sync = getProjectSync();
    const loader = getProjectLoader();
    const project = loader ? loader(normalized) : sync ? sync.load(normalized) : normalized;
    // lastCamera3dFov is tied to the project and must be cleared when switching projects, otherwise
    // 3D perspective will bleed over
    set({ project, projectLoadToken: state.projectLoadToken + 1, filePath, dirty: false, t: 0, playing: false, selection: [], selectedCameraId: null, playToken: state.playToken + 1, durationManual: null, lastCamera3dFov: null });
  },
  newProject(name?: string) {
    coreActions.loadProject(createEmptyProject(name));
  },
  markSaved(filePath: string | null) {
    set({ filePath, dirty: false });
  },
  undo() {
    const sync = getProjectSync();
    if (sync) return sync.undo();
    const prev = history.pop();
    if (!prev) return;
    future.push(state.project);
    set({ project: prev, dirty: true });
  },
  redo() {
    const sync = getProjectSync();
    if (sync) return sync.redo();
    const next = future.pop();
    if (!next) return;
    history.push(state.project);
    set({ project: next, dirty: true });
  },
  canUndo(): boolean {
    const sync = getProjectSync();
    return sync ? sync.canUndo() : history.length > 0;
  },
  canRedo(): boolean {
    const sync = getProjectSync();
    return sync ? sync.canRedo() : future.length > 0;
  },
};
