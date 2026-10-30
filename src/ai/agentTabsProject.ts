import { getState, subscribe } from "../store/project";
import { setAgentProject } from "./agentTabs";

/**
 * 让 AI 栏的分页清单跟着编辑器此刻打开的项目走(清单按项目分开,见 agentTabs.ts)。
 *
 * 盯着编辑器 store 的项目 id 和 `projectLoadToken`(每次载入项目加一):换了项目、或同一个项目重新载入,都通知 agentTabs。
 * 单独一个文件是为了让 agentTabs.ts 不依赖 store,Node 里的单测能直接载入它。
 * 导入本文件就会接上(railStore.ts 导入它);模块载入时先对一次,所以第一次读清单时已经是当前项目的。
 */
let lastToken = -1;
let lastId = "";

function follow() {
  const s = getState();
  const id = typeof s.project?.id === "string" ? s.project.id : "";
  if (s.projectLoadToken === lastToken && id === lastId) return;
  lastToken = s.projectLoadToken;
  lastId = id;
  setAgentProject(id);
}

follow();
subscribe(follow);
