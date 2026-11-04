import type { ChatMessage } from "./types";
import { getScript, setScript } from "./script";
import { getChatStore, getMessages, messagesForSave, replaceMessages } from "./liveChat";
import { resetAiSessionIds } from "./aiSessionKeys";
import { getRealTabs, noteProjectChatApplied } from "./agentTabs";

/**
 * The AI state saved and loaded with the project: script + this chat.
 *
 * It sits alongside `project` in .proc rather than being stuffed inside the Project object:
 * Project is returned to the model as is by `get_project`, and putting the whole chat history in
 * it would mean re-reading its own words on every call, which is both expensive and easy to get
 * tangled in.
 *
 * That is where "one chat per project" comes from: whichever .proc is opened, that copy is poured
 * back in.
 */
export interface ProjectAi {
  /** The script; an empty string means nothing was written */
  script: string;
  /** Visible chat (without the execution trace, see liveChat.messagesForSave) */
  messages: ChatMessage[];
}

/**
 * What is saved with the project file is the chat of this project's first session (the first real tab
 * in the manifest). In old versions that was the main tab ("main", whose store is the main chat
 * store); after the tab manifest was split per project, each newly created session has its own store,
 * so it is taken per tab. It is empty when there are no sessions.
 * The next time this project file is opened on a machine that has no tab manifest for it, this chat
 * is filled in as the project's "Agent 1" (agentTabs.setAgentProject).
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
 * Pour an AI state back in. Passing null / undefined (an old .proc has no such section) clears it:
 * opening a project that has no chat record must not show the previous project's chat.
 */
export function applyProjectAi(ai: unknown): void {
  const src = (ai && typeof ai === "object" ? ai : {}) as Partial<ProjectAi>;
  setScript(typeof src.script === "string" ? src.script : "");
  replaceMessages(src.messages);
  // The tab manifest is split per project: if the project brings its own chat, a tab is added to hold
  // that chat right after the project is switched (agentTabs.setAgentProject)
  noteProjectChatApplied(getMessages().length > 0);
  resetAiSessionIds();
}

/** New project: clear both */
export function resetProjectAi(): void {
  applyProjectAi(null);
}

/** Whether there is anything worth saving, used to decide whether to write this section into .proc */
export function hasProjectAi(): boolean {
  return getScript().trim() !== "" || (savedStore()?.get().length ?? 0) > 0;
}
