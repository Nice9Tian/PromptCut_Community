/**
 * Vibe 模式里此刻连着的那个项目的云端 Agent:对话列表(侧栏的「项目 Agent」)、当前这条对话的消息、发送、停止、共有 / 私有。
 *
 * 业务一律沿用编辑器右栏与手机版的同一套(`src/ai/cloud/useCloud.ts` 的 `useCloudChat`,做法照 `src/mobile/AgentChat.tsx`):
 *   - 发出去之前先过「告知托管方能读」(`product/agent.md`「告知托管方能读」):第一次用时弹框,选「我知道了」才发,按账号记住;
 *   - 发送是乐观显示:点了当场出自己的气泡,发不出去时那条气泡标「没有发出去」、原文放回输入框;断网时排着等网络恢复;
 *   - 对话权限(谁能发、谁能停、谁能切共有 / 私有)照 `cloudConversationControlPolicy`,只读成员(游客进别人的项目)不能发;
 *   - 侧栏列的对话来自同一份历史列表,再按共有 / 私有规则复核一遍(`vibeOrg.ts` 的 `viewableChats`),别人的私有对话不列。
 *
 * 只在项目连上之后才有东西:没连项目时 `useCloudChat` 的键是空的,什么请求都不发。
 * 改动修改前 / 修改后的画面记录(右侧拓展栏)按当前对话设读取范围(`ToolVisual.tsx` 的 `setCloudVisualScope`)。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCloudAgent, useCloudChat, type CloudAgentState, type CloudChat } from "../ai/extensions";
import { CloudError, cloudConversationControlPolicy, cloudErrorText } from "../ai/extensions";
import { cloudTicket } from "../ai/extensions";
import { acceptCloudConsent, cloudConsentState, refreshCloudConsent, subscribeCloudConsent } from "../ai/extensions";
import { OUTBOX_RESEND_EVENT } from "../ai/outbox";
import { isIdleHead } from "../ai/chatTypes";
import { useSync } from "../editor/sync/syncManager";
import { useReadOnly } from "../editor/readOnly";
import { setCloudVisualScope } from "../editor/right/ToolVisual";
import { viewableChats } from "./vibeOrg";
import type { VibeAgent } from "./vibeAgent";
import type { VibeChat } from "./types";

/** 这一套占的对话页签号(`useCloudChat` 的本地存储键按它分):和编辑器右栏、手机版的页签互不相干 */
export const VIBE_TAB = "vibe";

/** 云端 Agent 的那一份。聊天页只认 `VibeAgent`(桌面版那一份见 `useVibeLocal.ts`),这里多出来的是云端才有的东西 */
export interface VibeCloud extends VibeAgent {
  cloud: CloudAgentState;
  chat: CloudChat;
  /** 侧栏里这个项目底下列的对话(已按权限复核);当前那条还没发过消息的新对话也在里面(`fresh`) */
  chats: VibeChat[];
  /** 正在看的那条对话 */
  current: VibeChat | null;

  canSwitchVisibility: boolean;
  toggleVisibility: () => Promise<void>;
}

export function useVibeCloud(o: { connected: boolean; shown: boolean }): VibeCloud {
  const cloud = useCloudAgent();
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const creator = useSync((s) => s.shared?.creator === true);
  const ro = useReadOnly();
  const chat = useCloudChat({ tabId: VIBE_TAB, cloud, enabled: o.connected, autoAttach: false, outbox: true });
  const { view } = chat;
  const projectId = o.connected ? cloud.projectId : null;

  const qKey = `${cloud.accountId ?? "none"}:${consent.bindingVersion}:${projectId ?? "none"}`;
  const keyRef = useRef(qKey);
  keyRef.current = qKey;
  const stillCurrent = () => keyRef.current === qKey &&
    cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion;

  /* ---------- 告知(同手机版、桌面右栏) ---------- */
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  useEffect(() => {
    if (!o.shown || !projectId || !cloud.available || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(
      (accepted) => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      (error) => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); },
    );
    return () => { dead = true; };
  }, [o.shown, projectId, cloud.available, cloud.accountId, consent.accountId, consent.bindingVersion]);
  useEffect(() => { setConsentOpen(false); setConsentError(null); }, [qKey]);

  const admit = async (): Promise<boolean | "queue"> => {
    if (!stillCurrent()) return false;
    if (!cloud.accountId || consent.accountId !== cloud.accountId) { setConsentError("请先登录当前项目的账号。"); return false; }
    const expected = { accountId: cloud.accountId, bindingVersion: consent.bindingVersion };
    try {
      const accepted = await refreshCloudConsent(expected);
      if (!stillCurrent()) return false;
      if (!accepted) { setConsentError(null); setConsentOpen(true); }
      return accepted;
    } catch (error) {
      if (!stillCurrent()) return false;
      if (chat.outbox.transient(error)) return "queue";
      setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。");
      setConsentOpen(true);
      return false;
    }
  };

  /* ---------- 权限 ---------- */
  const currentMeta = chat.history.items.find((item) => item.id === chat.conversationId) ?? null;
  const policy = cloudConversationControlPolicy({
    accountMode: cloud.accountMode, accountId: cloud.accountId, creator, conversation: currentMeta,
    queue: view.queue, senders: view.senders, legacyStreaming: view.streaming,
  });
  const off = !cloud.enabled || chat.info?.enabled === false;
  const whyNot = !projectId ? "还没有打开项目。"
    : !cloud.available ? "这个项目所在的托管端没有云端 Agent 服务。"
    : off ? cloudErrorText("disabled")
    : ro.locked ? "你在这个项目里只能查看，不能给云端 Agent 发消息。"
    : policy.creatorReadOnly ? "这是别的成员的私有对话：项目创建者只能看，不能在里面发消息。"
    : view.revoked ? "这个对话你已经没有读取权限了。"
    : null;

  /* ---------- 侧栏要的对话 ---------- */
  const chats = useMemo(() => {
    if (!projectId) return [];
    const list = viewableChats(chat.history.items, { accountId: cloud.accountId, creator }, projectId);
    // 刚开的新对话服务端还没有:先在本页列上,发过第一条之后列表里就有了
    if (chat.conversationId && !list.some((c) => c.id === chat.conversationId)) {
      list.unshift({ id: chat.conversationId, name: chat.messages.length ? "云端对话" : "新对话", projectId, state: "idle", visibility: "shared", readOnly: false, fresh: true });
    }
    return list;
  }, [chat.history.items, chat.conversationId, chat.messages.length, projectId, cloud.accountId, cloud.accountMode, creator, consent.accepted]);
  const current = chats.find((c) => c.id === chat.conversationId) ?? null;

  /* ---------- 修改前 / 修改后的画面记录:按当前对话设读取范围 ---------- */
  useEffect(() => {
    if (!projectId || !cloud.url || !chat.conversationId) { setCloudVisualScope(null); return; }
    setCloudVisualScope({
      baseUrl: cloud.url, projectId, conversationId: chat.conversationId, accountId: cloud.accountId,
      visibility: currentMeta?.visibility, revoked: view.revoked === true, ticket: cloudTicket,
    });
  }, [projectId, cloud.url, cloud.accountId, chat.conversationId, currentMeta?.visibility, view.revoked]);
  useEffect(() => () => setCloudVisualScope(null), []);

  /* ---------- 「没发出去」气泡上的重新发送 ---------- */
  const resendRef = useRef(chat.outbox.resend);
  resendRef.current = chat.outbox.resend;
  useEffect(() => {
    const onResend = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      if (typeof id === "string") resendRef.current(id);
    };
    window.addEventListener(OUTBOX_RESEND_EVENT, onResend as EventListener);
    return () => window.removeEventListener(OUTBOX_RESEND_EVENT, onResend as EventListener);
  }, []);

  /* ---------- 发送、停止、共有 / 私有 ---------- */
  const send = async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!body) return false;
    if (whyNot) { chat.notify(whyNot); return false; }
    if (!cloud.accountMode) {
      if (await admit() !== true) return false;
      return chat.send(body);
    }
    const staged = chat.stage(body);
    if (staged && (chat.outbox.offline() || chat.outbox.mustQueue()) && chat.outbox.enqueue(body, undefined, staged)) return true;
    const admitted = await admit();
    if (admitted === "queue" && staged && stillCurrent() && chat.outbox.enqueue(body, undefined, staged)) return true;
    if (admitted !== true || !stillCurrent()) {
      if (staged) chat.failStaged(staged, "使用云端 Agent 前，请先阅读并确认告知。");
      return false;
    }
    const ok = await chat.send(body, undefined, staged ?? undefined, null, { queueOnNetwork: true });
    return stillCurrent() && ok;
  };

  const reqRef = useRef<{ key: string; id: string } | null>(null);
  const requestId = (key: string) => {
    if (reqRef.current?.key !== key) reqRef.current = { key, id: crypto.randomUUID() };
    return reqRef.current.id;
  };
  const stop = async () => {
    if (!cloud.accountMode) { await chat.abort(); return; }
    if (!policy.canStop || !policy.currentRunId) { chat.notify("只能停止自己发起的任务。"); return; }
    try {
      await chat.abort(policy.currentRunId, requestId(`stop:${policy.currentRunId}`));
      reqRef.current = null;
      void chat.history.refresh();
    } catch (error) {
      chat.notify(error instanceof Error ? error.message : "停止请求没有成功，可以再点一次。");
    }
  };
  const toggleVisibility = async () => {
    if (!policy.canSwitchVisibility || !currentMeta) return;
    const target = currentMeta.visibility === "private" ? "shared" : "private";
    try {
      await chat.switchVisibility(target, requestId(`vis:${chat.conversationId}:${target}`));
      reqRef.current = null;
      await chat.history.refresh();
    } catch (error) {
      chat.notify(error instanceof CloudError ? error.message : "暂时没能切换，可以再点一次。");
    }
  };

  const banner = view.connection === "reconnecting"
    ? "和云端 Agent 的连接断了，正在重新连接。云端的这一轮仍在继续，连上后会把错过的过程补齐。"
    : chat.notice;

  return {
    cloud, chat, chats, current,
    me: cloud.accountId, projectId: cloud.projectId,
    hint: "在云端运行，关闭后继续；重新打开可接着看。",
    canSend: !whyNot, whyNot,
    streaming: policy.streaming, canStop: policy.canStop,
    // 和编辑器右栏同一个数法(`QueueList.tsx`):执行服务在问时,对话空闲时排第一的那条马上就开始,不算排队
    queued: view.queue?.items.filter((i) => i.state === "queued" && !(chat.info?.executorMounted === true && isIdleHead(view.queue, i))).length ?? 0,
    waitingExecutor: cloud.accountMode && !!chat.info && chat.info.executorMounted !== true,
    consent: {
      open: o.shown && consentOpen && Boolean(consent.accountId) && consent.accountId === cloud.accountId,
      pending: consent.pending, error: consentError,
      accept: () => {
        void acceptCloudConsent().then(
          () => { setConsentError(null); setConsentOpen(false); },
          (error) => setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"),
        );
      },
      reject: () => { setConsentError(null); setConsentOpen(false); },
    },
    send, stop,
    canSwitchVisibility: policy.canSwitchVisibility,
    toggleVisibility,
    banner,
    clearBanner: chat.clearNotice,
  };
}
