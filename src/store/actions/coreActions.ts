import { createEmptyProject, newProjectId, type Project } from "../../kernel/project";
import { normalizeCuts } from "../../kernel/cuts";

import { state, history, future, set, getProjectSync, getProjectLoader } from "../core";

export const coreActions = {
  /* ---------- 文档 ---------- */
  loadProject(p: Project, filePath: string | null = null) {
    history.length = 0;
    future.length = 0;
    // 所有加载路径的唯一入口,在这里把项目补成多剪辑形状:老文件没有 cuts 就补成默认三条。
    // 顺带兜住身份:定制卡的归属认 project.id,哪条路进来的项目都得有一个(见 Project.id)
    const normalized = normalizeCuts(p.id ? p : { ...p, id: newProjectId() });
    // 连着文档服务时,载入就是一次根替换(docsync 负责提交、清它自己的撤销栈)
    const sync = getProjectSync();
    const loader = getProjectLoader();
    const project = loader ? loader(normalized) : sync ? sync.load(normalized) : normalized;
    // lastCamera3dFov 跟着项目走,换项目要清掉,否则三维视角会串味
    set({ project, projectLoadToken: state.projectLoadToken + 1, filePath, dirty: false, t: 0, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null, lastCamera3dFov: null });
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
