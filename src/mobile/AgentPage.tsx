/**
 * Mobile app Agent tab (semantics `workflow/editing.md` "Mobile app interface" and "Agent tab in the
 * AI panel"; the Agent page of the demo `prototypes/mobile-ui-demo/`).
 *
 * A row of chat tabs on top (Agent 1, Agent 2..., each can be closed, "+" opens a new one) + the chat
 * page of the current session. The tab manifest is shared with desktop in `src/ai/agentTabs.ts`:
 * separate per project, keyed as "projectID_AgentID"; when the project has no session at all there is
 * only one item, "Start", and the chat page is the start page (presets + input box, with a guide
 * animation right after entering the project). The first session (Agent 1) is only created when the
 * user taps send. Each session mounts its own `AgentChat` (switching tabs does not unmount it, chats
 * in the background keep running).
 *
 * **Projects without an account** (the second screen on the LAN, `workflow/editing.md` "Second screen
 * on the LAN") connect to the **local Agent**
 * (`AgentChatLocal.tsx` → `../start/useVibeLocal.ts` → `src/ai/useAiChat.ts`): the tab bar, start
 * page, creativity level and quote bar stay as they are, only what sits underneath changes. The phone
 * and the computer are two browsers, their tab lists and messages live in their own pages, **not the
 * same chat**; what they share is the editor process on the computer (requests are sent by it to the
 * local Agent, and it changes the same project).
 */
import "../ai/agentTabsProject";
import { ONLINE } from "../online/mode";
import { useRef } from "react";
import { addTab, closeTab, activateTab, useAgentTabs } from "../ai/agentTabs";
import { useCloudAgent, useCloudNotices } from "../ai/extensions";
import { useStore } from "../store/project";
import { AgentTabsBar } from "./agentParts";
import { useConfirm } from "./ui";
import { AgentChat } from "./AgentChat";
import { AgentChatLocal } from "./AgentChatLocal";
import { tr } from "../i18n/index.ts";

export function AgentPage({ active }: { active: boolean }) {
  const cloud = useCloudAgent();
  useCloudNotices(cloud, cloud.available);
  const { tabs, activeId } = useAgentTabs();
  const confirm = useConfirm();
  const counts = useRef(new Map<string, number>());
  const projectId = useStore((s) => s.project.id) ?? null;
  /**
   * Projects without an account (the second screen on the LAN) connect to the local Agent, all others
   * connect to the cloud.
   *
   * The `!ONLINE &&` part must stay: the online build has no editor process and the local Agent does not
   * exist at all, and this branch is the **only surviving consumer** of
   * `useVibeLocal → useAiChat → providerState` in the online output ——
   * without it, the 8 /api/ai/* routes would be hoisted into the entry chunk (C10A-API-03 fails the
   * check). ONLINE is a compile-time constant, so this whole block is pruned.
   */
  const local = !ONLINE && !cloud.accountMode;

  const close = (id: string, title: string) => {
    if ((counts.current.get(id) ?? 0) === 0) { closeTab(id); return; }
    // The mobile app has no chat history list, so ask before closing. The two modes have different
    // consequences, so the wording differs: the cloud chat stays in the cloud history; the local one is
    // not archived in this version (archiving is done on the desktop AI panel side), so it is gone once closed
    const text = local
      ? tr("Close \"{0}\"? This chat won't be kept; closing it deletes it.", title)
      : tr("Close \"{0}\"? This chat will no longer show on mobile, but stays in the cloud chat history (open it in the desktop app).", title);
    confirm({ text, ok: tr("Close"), danger: true, run: () => closeTab(id) });
  };

  return (
    <div className="agent-page" data-pcm="agent-page" data-pcm-agent={local ? "local" : "cloud"}>
      <AgentTabsBar tabs={tabs} activeId={activeId} onActivate={activateTab} onClose={close}
        onNew={() => { const t = addTab(); activateTab(t.id); }} />
      {tabs.map((t) => (local
        ? <AgentChatLocal key={t.id} tabId={t.id} shown={active && t.id === activeId} projectId={projectId} counts={counts} />
        : <AgentChat key={t.id} tabId={t.id} shown={active && t.id === activeId} cloud={cloud} counts={counts} />))}
    </div>
  );
}
