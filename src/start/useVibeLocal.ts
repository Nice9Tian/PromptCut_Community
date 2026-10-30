/**
 * 氛围式里**桌面版**那一种 Agent:本机的 CLI / API Agent(`user-workflow.md`「Agent 接入方式」里的前两行)。
 *
 * 云端不是前提(用户 2026-10-23 定,原话「桌面版也要可以用。云端不是必须。因为聊天窗可以走用户的CLI或者API。」):
 * 桌面版的氛围式对话走的就是编辑界面 AI 栏的那一套 —— `src/ai/useAiChat.ts` 发请求、`src/ai/agentTabs.ts` 管分页,
 * 所以**同一个项目在氛围式和传统式里看到的是同一段对话**,来回切不丢。本模块只是把那一套翻成聊天页认的
 * `VibeAgent`(`vibeAgent.ts`),不自己造第二套对话。
 *
 * 和云端那一份(`useVibeCloud.ts`)的区别,都是本机没有的东西:
 *   - 没有账号,所以没有「谁发的」,也没有「告知托管方能读」—— `me` 为 null、`consent` 恒关;
 *   - 没有共有 / 私有,对话就是本机这一份;
 *   - 跑在本机:关掉软件这一轮就停了,这句写在输入框下面(`hint`),不照抄云端那句「关闭后继续」。
 *
 * 「这个项目底下有几条对话」用的是 AI 栏的 Agent 分页(每页一个独立 Agent,见 `agentTabs.ts` 文件头),
 * 侧栏里列的就是它们,点一条等于把那一页设为当前页。
 *
 * 手机版 Agent 分页也用这一份(`src/mobile/AgentChatLocal.tsx`),区别只有一样:它每个会话各挂一份、
 * 不跟着「当前页」走,所以把页号经 `tabId` 传进来。注意手机是另一张页面:分页清单与消息都在各自页面里,
 * 和电脑上的 AI 栏**不是同一段对话**;共用的是同一个编辑器进程与同一个项目。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAiChat } from "../ai/useAiChat";
import { activateTab, addTab, closeTab, commitDraft, setAgentProject, useAgentTabs } from "../ai/agentTabs";
import { enqueue as enqueueChat, getQueue, setPaused, useQueue } from "../ai/chatQueue";
import type { VibeAgent } from "./vibeAgent";
import type { VibeChat } from "./types";

export interface VibeLocal extends VibeAgent {
  /** 底下那一份 `useAiChat`。驱动条和「配置 Agent」那个窗口要整份,所以原样交出去 */
  ai: ReturnType<typeof useAiChat>;
  /** 侧栏里这个项目底下列的对话(= AI 栏的 Agent 分页) */
  chats: VibeChat[];
  /** 正在看的那条 */
  current: VibeChat | null;
  /** 当前这一页的 id(= `conversationId`) */
  tabId: string;
  openChat: (id: string) => void;
  newChat: () => void;
  /** 关掉一条对话(= 关掉那一页)。最后一页也能关,关光了回到占位的开始页 */
  removeChat: (id: string) => void;
}

/** 没打开项目时 `useAiChat` 也得挂着(hook 数目不能变),用这个页名,它不进存储 */
const NO_PROJECT_TAB = "vibe-local-idle";

export function useVibeLocal(o: { projectId: string | null; tabId?: string }): VibeLocal {
  /*
   * Agent 分页按项目分开。项目换了就换一份清单(没开项目时是 `none` 那一份,只在内存里)。
   *
   * 指定了页号的调用方(手机版 Agent 分页:每个会话各挂一份,切标签不卸载)自己让清单跟着项目走
   * (`src/ai/agentTabsProject.ts`),这里就不再设一遍 —— 同一个项目被几份实例抢着设,等于白跑。
   */
  const owns = o.tabId === undefined;
  useEffect(() => { if (owns) setAgentProject(o.projectId); }, [owns, o.projectId]);

  const tabs = useAgentTabs();
  const tabId = o.tabId ?? (o.projectId ? tabs.activeId : NO_PROJECT_TAB);
  const ai = useAiChat({ tabId });
  const queue = useQueue(tabId);

  /** 顶上那条红字是 `useAiChat` 的 error。它自己没有「清掉」的入口,所以在这一层记一下关掉的是哪一条 */
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
      // 本机对话没有共有 / 私有,也没有「别人的私有对话」这回事
      visibility: "shared" as const,
      readOnly: false,
      // 占位的开始页:还没发过第一条消息,和云端那边「还没发过消息的新对话」是同一种东西
      ...(t.draft ? { fresh: true } : {}),
    }));
  }, [o.projectId, tabs.tabs]);
  const current = chats.find((c) => c.id === tabId) ?? null;

  /**
   * 发不了的原因。**「还在找」和「一个都没有」要分开说** —— 刚进来那一两秒 `useAiChat` 正在问服务端有哪些驱动
   * (`providers` 还是空的,`provider` 还是 null),这时候写「还没选 Agent」是冤枉人:过一会儿它自己就选上了。
   */
  const looking = ai.providers.length === 0;
  const whyNot = !o.projectId
    ? "先在左边打开一个项目，再和它的 Agent 说话。"
    : ai.provider
      ? null
      : looking
        ? "正在找这台机器上的 Agent…"
        : "还没选 Agent：点上面的「配置 Agent」挑一个本机的命令行 Agent，或填一个 API 密钥。";

  /** 发送。这一页在跑就排队(不打断它),空闲就直发 —— 和 AI 栏的 `handleSend` 同一条路 */
  const send = useCallback(async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body || whyNot) return false;
    // 占位的开始页:点了发送才变成本项目的第一个真会话
    commitDraft(tabId);
    if (ai.isBusy()) { enqueueChat(tabId, { text: body }); return true; }
    return ai.send(body);
  }, [whyNot, tabId, ai]);

  /** 停:停掉这一轮,队列里还排着的暂停,不自动接着发(同 AI 栏的「■ 停止」) */
  const stop = useCallback(async () => {
    if (getQueue(tabId).length > 0) setPaused(tabId, true);
    ai.abort();
  }, [tabId, ai]);

  // 关掉一页之后 `useAiChat` 还挂在这一页上:切到清单给出的新当前页由 `useAgentTabs` 自己推，这里只管关
  const openChat = useCallback((id: string) => activateTab(id), []);
  const newChat = useCallback(() => { addTab(); }, []);
  const removeChat = useCallback((id: string) => closeTab(id), []);

  /** 告知托管方只和云端有关,本机这一份永远是关的。写成常量对象会每次重建,聊天页的 effect 跟着抖 */
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
      // 本机没有「别人」,不标发送者
      view: {},
      // 本机对话就在内存里,不用等服务端回历史
      history: { loaded: true },
    },
    me: null,
    projectId: o.projectId,
    hint: "在本机运行，关掉软件这一轮就停了。",
    canSend: !whyNot,
    whyNot,
    streaming: ai.streaming,
    canStop: ai.streaming,
    queued: queue.items.length,
    // 本机 Agent 就在这台机器上跑,没有「等云端执行服务」这回事
    waitingExecutor: false,
    consent,
    send,
    stop,
    banner,
    clearBanner,
  };
}
