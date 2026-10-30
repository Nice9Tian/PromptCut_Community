/**
 * 手机版 Agent 分页(语义 `workflow/editing.md`「手机版界面」「AI 栏的 Agent 标签」;演示稿 `prototypes/mobile-ui-demo/` 的 Agent 页)。
 *
 * 上面一排对话标签(Agent 1、Agent 2……,每个都能关,「+」新开)+ 当前会话的对话页。标签清单和桌面共用 `src/ai/agentTabs.ts`:
 * 按项目分开、标记是「项目ID_AgentID」;本项目一个会话都没有时只有一项「开始」,对话页是开始页(预设 + 输入框,刚进项目时带引导动画),
 * 用户点发送才建第一个会话(Agent 1)。每个会话各挂一份 `AgentChat`(切标签不卸载,后台的对话照跑)。
 *
 * **没有账号的项目**(局域网里的第二块屏,`workflow/editing.md`「局域网里的第二块屏」)接的是**本机 Agent**
 * (`AgentChatLocal.tsx` → `../start/useVibeLocal.ts` → `src/ai/useAiChat.ts`):标签栏、开始页、创造力、
 * 引用标记条照旧,换的只是底下接谁。手机和电脑是两个浏览器,分页清单与消息都在各自页面里,**不是同一段对话**;
 * 共用的是电脑上那个编辑器进程(请求由它发给本机 Agent,改的是同一个项目)。
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

export function AgentPage({ active }: { active: boolean }) {
  const cloud = useCloudAgent();
  useCloudNotices(cloud, cloud.available);
  const { tabs, activeId } = useAgentTabs();
  const confirm = useConfirm();
  const counts = useRef(new Map<string, number>());
  const projectId = useStore((s) => s.project.id) ?? null;
  /**
   * 没有账号的项目(局域网里的第二块屏)接本机 Agent,其余接云端。
   *
   * `!ONLINE &&` 这一节不能少:在线构建里没有编辑器进程、本机 Agent 根本不存在,而这一支是
   * `useVibeLocal → useAiChat → providerState` 在在线产物里**唯一存活的消费者** ——
   * 漏了它,8 个 /api/ai/* 会被提进入口块(C10A-API-03 判红)。ONLINE 是编译期常量,这里会整段剪掉。
   */
  const local = !ONLINE && !cloud.accountMode;

  const close = (id: string, title: string) => {
    if ((counts.current.get(id) ?? 0) === 0) { closeTab(id); return; }
    // 手机版没有历史对话列表,所以关之前先问一声。两种模式后果不一样,话也不一样:
    // 云端那段对话仍留在云端历史里;本机这一份这一版不归档(归档是电脑 AI 栏那边在做的事),关了就没了
    const text = local
      ? `关闭「${title}」?这段对话不会留下来,关掉就没了。`
      : `关闭「${title}」?这段对话在手机上不再显示,仍保存在云端的对话历史里(桌面版可以打开)。`;
    confirm({ text, ok: "关闭", danger: true, run: () => closeTab(id) });
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
