/**
 * The kind of Agent for **the desktop app** in Vibe mode: the local CLI / API Agent (the first two rows of
 * "Agent connection types" in `user-workflow.md`).
 *
 * The cloud is not a prerequisite (user decision, 2026-10-23, verbatim: "The desktop app must work too.
 * The cloud is not required. Because the chat window can go through the user's CLI or API."):
 * the desktop app's Vibe-mode chat goes through the same set as the AI panel of the editor:
 * `src/ai/useAiChat.ts` sends requests and `src/ai/agentTabs.ts` manages the tabs, so **the same
 * project shows the same chat in Vibe mode and in Classic mode**, and switching back and forth loses
 * nothing. This module only translates that set into the `VibeAgent` that the chat page recognizes
 * (`vibeAgent.ts`); it does not build a second chat system of its own.
 *
 * What differs from the cloud version (`useVibeCloud.ts`) is all things that the local machine does not
 * have:
 *   - No account, so no "who sent it" and no "host-can-read notice": `me` is null and `consent` is always
 *     off;
 *   - No shared / private: the chat is just this local copy;
 *   - It runs locally: closing the software stops the round, and this sentence is written under the input
 *     box (`hint`) rather than copying the cloud sentence "Continues after closing".
 *
 * "How many chats this project has" uses the Agent tabs of the AI panel (each tab is an independent Agent,
 * see the header of `agentTabs.ts`), and those are what the sidebar lists; clicking one sets that tab as
 * the current tab.
 *
 * The mobile app's Agent tabs use this version too (`src/mobile/AgentChatLocal.tsx`), with only one
 * difference: each session mounts its own copy and does not follow the "current tab", so the tab number
 * is passed in through `tabId`. Note that the phone is a different page: the tab manifest and the
 * messages live in each page, and are **not the same chat** as the AI panel on the computer; what they
 * share is the same editor process and the same project.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiChat } from "../ai/useAiChat";
import { activateTab, addTab, closeTab, commitDraft, setAgentProject, useAgentTabs } from "../ai/agentTabs";
import { enqueue as enqueueChat, getQueue, setPaused, useQueue } from "../ai/chatQueue";
import type { VibeAgent } from "./vibeAgent";
import type { VibeChat } from "./types";
import { tr } from "../i18n/index.ts";

export interface VibeLocal extends VibeAgent {
  /** The `useAiChat` underneath. The driver bar and the "Configure Agent" window need the whole thing, so it is handed out as is */
  ai: ReturnType<typeof useAiChat>;
  /** The chats listed under this project in the sidebar (= the Agent tabs of the AI panel) */
  chats: VibeChat[];
  /** The one being viewed */
  current: VibeChat | null;
  /** The id of the current tab (= `conversationId`) */
  tabId: string;
  openChat: (id: string) => void;
  newChat: () => void;
  /** Close a chat (= close that tab). The last tab can be closed too, and when all are closed it returns to the placeholder start page */
  removeChat: (id: string) => void;
}

/** When no project is open `useAiChat` still has to stay mounted (the number of hooks cannot change); use this tab name, which is not stored */
const NO_PROJECT_TAB = "vibe-local-idle";

export function useVibeLocal(o: { projectId: string | null; tabId?: string }): VibeLocal {
  /*
   * Agent tabs are kept apart per project. When the project changes, the manifest changes with it (with no
   * project open it is the `none` one, which lives only in memory).
   *
   * Callers that specify a tab number (the mobile app's Agent tabs: each session mounts its own copy, and
   * switching tabs does not unmount) make the manifest follow the project themselves
   * (`src/ai/agentTabsProject.ts`), so it is not set again here: when several instances race to set the
   * same project, the work is wasted.
   */
  const owns = o.tabId === undefined;
  useEffect(() => { if (owns) setAgentProject(o.projectId); }, [owns, o.projectId]);

  const tabs = useAgentTabs();
  const tabId = o.tabId ?? (o.projectId ? tabs.activeId : NO_PROJECT_TAB);
  const ai = useAiChat({ tabId });
  const queue = useQueue(tabId);

  /** The red text at the top is the error of `useAiChat`. It has no "dismiss" entry of its own, so this layer remembers which one was dismissed */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const banner = ai.error && ai.error !== dismissed ? ai.error : null;
  const clearBanner = useCallback(() => setDismissed(ai.error), [ai.error]);

  const chats = useMemo<VibeChat[]>(() => {
    if (!o.projectId) return [];
    return tabs.tabs.map((t) => ({
      id: t.id,
      name: t.title,
      projectId: o.projectId!,
      state: t.busy ? ("running" as const) : ("idle" as const),
      // Local chats have no shared / private, and no such thing as "someone else's private chat"
      visibility: "shared" as const,
      readOnly: false,
      // The placeholder start page: no first message has been sent yet, which is the same thing as the cloud side's "new chat that has not sent a message yet"
      ...(t.draft ? { fresh: true } : {}),
    }));
  }, [o.projectId, tabs.tabs]);
  const current = chats.find((c) => c.id === tabId) ?? null;

  /**
   * The reason sending is not possible. **"Still looking" and "none at all" must be told apart**: in the
   * first second or two, `useAiChat` is asking the server which drivers exist (`providers` is still empty
   * and `provider` is still null), and writing "No Agent selected yet" at that moment would be unfair: it
   * selects one by itself a moment later.
   */
  const looking = ai.providers.length === 0;
  const whyNot = !o.projectId
    ? tr("Open a project on the left first, then talk to its Agent.")
    : ai.provider
      ? null
      : looking
        ? tr("Looking for Agents on this machine…")
        : tr("No Agent selected yet: click \"Configure Agent\" above to pick a local CLI Agent, or enter an API key.");

  /** Send. If this tab is running, queue (without interrupting it); if idle, send directly: the same path as `handleSend` of the AI panel */
  const send = useCallback(async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body || whyNot) return false;
    // The placeholder start page: it becomes this project's first real session only once send is clicked
    commitDraft(tabId);
    if (ai.isBusy()) { enqueueChat(tabId, { text: body }); return true; }
    return ai.send(body);
  }, [whyNot, tabId, ai]);

  /** Stop: stop this round, and whatever is still queued is paused and not sent automatically (same as "■ Stop" in the AI panel) */
  const stop = useCallback(async () => {
    if (getQueue(tabId).length > 0) setPaused(tabId, true);
    ai.abort();
  }, [tabId, ai]);

  // After a tab is closed, `useAiChat` is still mounted on that tab: switching to the new current tab given by the manifest is pushed by `useAgentTabs` itself; here we only handle closing
  const openChat = useCallback((id: string) => activateTab(id), []);
  const newChat = useCallback(() => { addTab(); }, []);
  const removeChat = useCallback((id: string) => closeTab(id), []);

  /** The host notice only concerns the cloud, and the local copy is always off. Writing it as a constant object would rebuild it every time, and the chat page's effect would jitter along */
  const consent = useRef({ open: false, pending: false, error: null, accept: () => {}, reject: () => {} }).current;

  return {
    ai,
    chats,
    current,
    tabId,
    openChat,
    newChat,
    removeChat,
    chat: {
      messages: ai.messages,
      conversationId: tabId,
      // There is no "someone else" locally, so the sender is not marked
      view: {},
      // Local chats are in memory, so there is no need to wait for the server to return the history
      history: { loaded: true },
    },
    me: null,
    projectId: o.projectId,
    hint: tr("Runs on this machine; closing the app stops this turn."),
    canSend: !whyNot,
    whyNot,
    streaming: ai.streaming,
    canStop: ai.streaming,
    queued: queue.items.length,
    // The local Agent runs right on this machine, so "waiting for the cloud execution service" does not exist
    waitingExecutor: false,
    consent,
    send,
    stop,
    banner,
    clearBanner,
  };
}
