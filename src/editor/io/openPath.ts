import { loadProc } from "./proc";
import { forgetSaveTarget } from "./proc";
import { setActiveDraftId } from "./drafts";
import { actions } from "../../store/project";
import type { Project } from "../../kernel/project";

/**
 * 按磁盘路径打开一份 .proc(双击文件、桌面壳的启动参数、Skill 结果链接都走这里)。
 *
 * 浏览器读不了任意路径,所以让服务端来:它**先复制一份**到项目根的 .pc-work/opened/ 下,
 * 再把副本的内容给回来。原文件从头到尾不被占用、不被改 —— 双击一份别人正在编辑的
 * .proc 不会互相踩;保存走「另存为」由用户自己挑落点。
 */
export async function openProcPath(filePath: string): Promise<{ project: Project; copy: string }> {
  const res = await fetch("/api/skill/open-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `打不开这个文件(${res.status})`);
  const project = loadProc(data.text);
  actions.loadProject(project, data.name);
  // 副本不属于任何草稿:保存时另存为,不会覆盖别人的文件
  setActiveDraftId(null);
  forgetSaveTarget();
  return { project, copy: data.copy };
}
