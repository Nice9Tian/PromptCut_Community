import type { ChatMessage } from "./types";
import { getScript, setScript } from "./script";
import { getChatStore, getMessages, messagesForSave, replaceMessages } from "./liveChat";
import { resetAiSessionIds } from "./aiSessionKeys";
import { getRealTabs, noteProjectChatApplied } from "./agentTabs";

/**
 * 随项目一起存取的 AI 状态:剧本 + 这段对话。
 *
 * 它和 `project` 平级放在 .proc 里,而不是塞进 Project 对象内部 ——
 * Project 会被 `get_project` 原样返回给模型,把整段对话history 放进去
 * 等于每次调用都把自己说过的话再读一遍,又贵又容易绕。
 *
 * 「每个项目一份对话」就是这么来的:打开哪个 .proc,就灌回哪一份。
 */
export interface ProjectAi {
  /** 剧本;空串表示没写 */
  script: string;
  /** 可见对话(不含执行轨迹,见 liveChat.messagesForSave) */
  messages: ChatMessage[];
}

/**
 * 随项目文件存的是本项目第一个会话(清单里排第一的真页)的对话。老版本里它就是主页(「main」,store 即主对话 store);
 * 分页清单按项目分开之后新建的会话各有自己的 store,所以按页取。没有会话时是空的。
 * 下次打开这个项目文件而本机没有它的分页清单时,这段对话补成该项目的「Agent 1」(agentTabs.setAgentProject)。
 */
function savedStore() {
  const first = getRealTabs()[0];
  return first ? getChatStore(first.id) : null;
}

export function collectProjectAi(): ProjectAi {
  const store = savedStore();
  return { script: getScript(), messages: store ? messagesForSave(100, store) : [] };
}

/**
 * 灌回一份 AI 状态。传 null / undefined(旧的 .proc 没有这一段)就清空 ——
 * 打开一个没有对话记录的项目,不该看到上一个项目的对话。
 */
export function applyProjectAi(ai: unknown): void {
  const src = (ai && typeof ai === "object" ? ai : {}) as Partial<ProjectAi>;
  setScript(typeof src.script === "string" ? src.script : "");
  replaceMessages(src.messages);
  // 分页清单按项目分开:项目自带对话的话,紧接着换项目时给它补一个页接住这段对话(agentTabs.setAgentProject)
  noteProjectChatApplied(getMessages().length > 0);
  resetAiSessionIds();
}

/** 新建项目:两样都清空 */
export function resetProjectAi(): void {
  applyProjectAi(null);
}

/** 有没有值得存的东西,用来决定 .proc 里要不要写这一段 */
export function hasProjectAi(): boolean {
  return getScript().trim() !== "" || (savedStore()?.get().length ?? 0) > 0;
}
