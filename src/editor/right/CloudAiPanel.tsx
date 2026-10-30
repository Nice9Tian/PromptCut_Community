import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./AiPanel.css";
import "./CloudAiPanel.css";
// 公式样式表:LiveMarkdown 用 KaTeX 渲染数学
import "katex/dist/katex.min.css";
import { useCloudChat, type CloudAgentState } from "../../ai/extensions";
import { leaveCloudTab } from "../../ai/tabMode";
import { CloudError, cloudConversationControlPolicy, cloudErrorText, createCloudControlScopeGuard, type CloudControlScopeToken } from "../../ai/extensions";
import { CLOUD_ATTACH_ACCEPT, CLOUD_ATTACH_NEED_TEXT, CLOUD_ATTACH_TITLE, cloudAttachKindOfName, newCloudAttachId, pickSendable } from "../../ai/cloudAttach";
import { setTabBusy, setTabConversation, useAgentTabs } from "../../ai/agentTabs";
import { MAIN_TAB } from "../../ai/liveChat";
import { useInstallJobs } from "../../ai/sttInstallStore";
import { enqueue, getQueue, clear as clearQueue, remove as removeQueued, setPaused as setQueuePaused, useQueue, type QueuedItem } from "../../ai/chatQueue";
import type { AiProvider, ChatAttachment, ProviderInfo, PublicAiConfig } from "../../ai/types";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { useViewPrefs, setShowThinking } from "./chat/viewPrefs";
import { ChatHeader } from "./chat/ChatHeader";
import { MessageList } from "./chat/MessageList";
import { CLOUD_RESEND_EVENT } from "./chat/UserBubble";
import { ThinkingStrip } from "./chat/ThinkingStrip";
import { CloudQueueList, QueueList } from "./chat/QueueList";
import { pushToast, setAccountAgentEnabled, useSync } from "../sync/syncManager";
import { Composer } from "./chat/Composer";
import { memberReadOnlyNow } from "../readOnlyCore";
import { useReadOnly } from "../readOnly";
import { StartHero, useStartPage } from "./chat/StartHero";
import { CloudModelBar } from "./CloudModelBar";
import { AgentActivityPanel, useRoundSelection } from "./chat/ActivityPanel";
import { RemoteAgentsStrip } from "./RemoteAgentsStrip";
import { ReportDialog } from "./ReportDialog";
import { cloudConversationReport } from "../../ai/cloudReport";
// 代码版本走 boot.ts 的贯穿型接缝取（活 E 建的 registerBuildInfo/getBuildInfo）。
// 这个面板是公开文件，不许直接引 cloud/online/buildInfo.ts；社区版缺省 codeVersion 是 null。
import { getBuildInfo } from "../../online/boot";
import { acceptCloudConsent, cloudConsentState, grantCloudConsent, onCloudConsentRequired, refreshCloudConsent, subscribeCloudConsent, type CloudConsentPermit } from "../../ai/extensions";
import { CloudAgentConsentDialog } from "./CloudAgentConsentDialog";
import { CloudDeleteChatDialog, type CloudDeleteAsk } from "./CloudDeleteChatDialog";
import { LIBRARY_KINDS, putInLibrary, type LibraryOutcome } from "./cloudAttachLibrary";
import { CLOUD_CHAT_TEXT } from "../../ai/chatTexts";
import { createPoller, type Poller } from "../../ai/poll";
import type { CloudChatItem } from "../../ai/chatTypes";
import { readQuote } from "../quoteBus";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

type CloudControlRequest =
  | { kind: "visibility"; target: "shared" | "private"; conversationId: string; requestId: string; scope: CloudControlScopeToken }
  | { kind: "stop"; runId: string; conversationId: string; requestId: string; scope: CloudControlScopeToken };

/** 从桌面版的 AI 栏嵌进来时,本机一侧要给的几样(在线页面不给) */
export interface CloudDesktopSide {
  providers: ProviderInfo[];
  provider: AiProvider | null;
  config: PublicAiConfig | null;
  /** 云端页里选了本机的某个驱动:回到本机模式 */
  onLeave: (p: AiProvider) => void;
}

/**
 * 「云端」接入方式的一个 AI 助手分页(契约 9.5)。在线浏览器宽屏下它是右侧 AI 栏的全部;桌面版里,
 * 一页选了「云端」就由它接管这一页(`AiPanel` 在那时交给它),选回本机驱动再还给 `AiPanel`。
 *
 * 与本机 Agent 的区别只在「这一轮在哪跑」:消息发到云节点的 Agent 服务(202,这一轮与本页的连接无关),
 * 页面按事件流看进展,断了自动重连补齐;关掉页面、退出软件,云端的这一轮照跑,重新打开自动接上。
 * 对话界面完全由事件重建,页面不存云端对话记录。
 *
 * 这里不碰任何 `/api/*`:模型、对话、工具执行全在云端,页面只打 `/agent/v1/*`。
 */
export function CloudAiPanel(props: {
  tabId?: string;
  active?: boolean;
  hotkeysOff?: boolean;
  cloud: CloudAgentState;
  desktop?: CloudDesktopSide;
  /** 从历史列表点进来的云端对话 */
  initialConversation?: string | null;
}) {
  const tabId = props.tabId ?? MAIN_TAB;
  const active = props.active ?? true;
  const { cloud, desktop } = props;
  const creator = useSync(state => state.shared?.creator === true);
  const [enabling, setEnabling] = useState(false);
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  useEffect(() => {
    if (!cloud.accountMode || !cloud.available || !cloud.projectId || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(accepted => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      error => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); });
    return () => { dead = true; };
    // A new account/project binding gets a fresh server result; rejecting does not trigger a loop.
  }, [cloud.accountMode, cloud.available, cloud.projectId, cloud.accountId, consent.accountId, consent.bindingVersion]);
  /**
   * 用之前向账号服务新读一次告知。放行时回 `{ permit }`：账号模式下是这次新读取发的一次性许可，
   * 交给同一次发送的 `chat.send`，那边当场核对仍有效就不再读第二次（一次发送只核一次告知）；不放行回 null。
   */
  const consentForUse = async (opts?: { queueable?: boolean }): Promise<{ permit: CloudConsentPermit | null } | { queue: true } | null> => {
    if (!cloud.accountMode) return { permit: null };
    if (!stillCurrent()) return null;
    const expected = cloud.accountId ? { accountId: cloud.accountId, bindingVersion: consent.bindingVersion } : null;
    if (!expected || consent.accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) {
      setConsentError("请先登录当前项目的账号。");
      return null;
    }
    try {
      const { accepted, permit } = await grantCloudConsent(expected);
      if (cloudConsentState().accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) return null;
      // 只有确实没同意才弹告知框；同意了但没拿到许可（permit 为 null）照常发，chat.send 发出前自己再读一次
      if (!accepted) { setConsentError(null); setConsentOpen(true); return null; }
      return { permit };
    } catch (error) {
      if (!stillCurrent()) return null;
      // 断网读不到告知:不弹告知框,这条消息排着等网络恢复(恢复后发出之前再核一次告知)
      if (opts?.queueable && chat.outbox.transient(error)) return { queue: true };
      setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。");
      setConsentOpen(true);
      return null;
    }
  };
  const acceptConsent = () => { void acceptCloudConsent().then(() => { if (stillCurrent()) { setConsentError(null); setConsentOpen(false); } },
    error => { if (stillCurrent()) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); }); };
  // 断网待发(2026-10-22 用户定):断网时发的消息排着、网络恢复后自动发出;排着的带附件的,真发出去之前同样先放进素材库
  const chat = useCloudChat({ tabId, cloud, enabled: true, autoAttach: true, initialConversation: props.initialConversation,
    outbox: true, prepareFiles: (files) => withLibrary(files) });
  const { view } = chat;
  const [metadataReadyKey, setMetadataReadyKey] = useState("");
  const [controlPending, setControlPending] = useState<CloudControlRequest | null>(null);
  const controlPendingRef = useRef<CloudControlRequest | null>(null);
  const controlInFlightRef = useRef<string | null>(null);
  const [controlNoteState, setControlNoteState] = useState<{ epoch: number; text: string } | null>(null);
  const qKey = cloud.accountMode ? `cloud:${tabId}:${cloud.accountId ?? "none"}:${consent.bindingVersion}:${cloud.projectId ?? "none"}` : `cloud:${tabId}`;
  const activeKeyRef = useRef(qKey);
  activeKeyRef.current = qKey;
  const stillCurrent = () => activeKeyRef.current === qKey && (!cloud.accountMode ||
    (cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion));
  useEffect(() => { if (cloud.accountMode) { setConsentOpen(false); setConsentError(null); } }, [cloud.accountMode, qKey]);
  // 这一页发的消息被拒在「没同意告知」上（发出前那次读取，或服务端收消息时回 consent-required）：弹告知框
  useEffect(() => {
    if (!cloud.accountMode) return;
    return onCloudConsentRequired((binding, origin) => {
      if (origin !== tabId || binding.accountId !== cloud.accountId || binding.bindingVersion !== consent.bindingVersion) return;
      setConsentError(null);
      setConsentOpen(true);
    });
  }, [cloud.accountMode, cloud.accountId, consent.bindingVersion, tabId]);
  const { tabs } = useAgentTabs();
  const tabTitle = desktop ? (tabs.find((t) => t.id === tabId)?.title ?? "AI 助手") : "云端 Agent";
  // 页签上的「对话 ID」是给本机 Agent 的多 Agent 通信用的;桌面版里这一页选回本机驱动后还要用它,云端的对话 id 不往里写
  // 开始页占位页还不是真会话(isDraft):点发送变成真页之后才记得上
  const isDraft = tabs.find((t) => t.id === tabId)?.draft === true;
  useEffect(() => { if (!desktop) setTabConversation(tabId, chat.conversationId); }, [tabId, chat.conversationId, desktop, isDraft]);
  const currentMeta = chat.history.items.find(item => item.id === chat.conversationId) ?? null;
  const controlPolicy = cloudConversationControlPolicy({ accountMode: cloud.accountMode, accountId: cloud.accountId,
    creator, conversation: currentMeta, queue: view.queue, senders: view.senders, legacyStreaming: view.streaming });
  const currentRunId = controlPolicy.currentRunId;
  const canStopCurrentRun = controlPolicy.canStop;
  const streaming = controlPolicy.streaming;
  const controlScopeGuardRef = useRef(createCloudControlScopeGuard());
  const controlScopeKey = JSON.stringify([qKey, cloud.accountId, cloud.projectId, cloud.url, cloud.identityVersion,
    consent.accountId, consent.bindingVersion, consent.accepted]);
  const controlScope = controlScopeGuardRef.current.update(controlScopeKey, chat.conversationId);
  const visibleControlPending = controlPending && controlScopeGuardRef.current.isCurrent(controlPending.scope) ? controlPending : null;
  const controlNote = controlNoteState?.epoch === controlScope.epoch ? controlNoteState.text : null;
  const setControlNote = (text: string | null) => setControlNoteState(text === null ? null : { epoch: controlScope.epoch, text });
  const isCurrentControl = (request: CloudControlRequest) => controlScopeGuardRef.current.isCurrent(request.scope);
  useEffect(() => { setControlPending(null); setControlNoteState(null); }, [controlScope.epoch]);
  if (controlPendingRef.current && !controlScopeGuardRef.current.isCurrent(controlPendingRef.current.scope)) controlPendingRef.current = null;
  if (controlInFlightRef.current && controlPendingRef.current?.requestId !== controlInFlightRef.current) controlInFlightRef.current = null;
  // Re-read permissions after the project switch or Agent service itself is restored.
  // Including these availability bits in the synchronous key keeps sending gated
  // during the render before the refresh effect runs.
  const metadataAvailabilityKey = `${cloud.enabled ? "on" : "off"}:${chat.info?.enabled === false ? "off" : "on"}`;
  const metadataKey = `${qKey}:${chat.conversationId}:${metadataAvailabilityKey}`;
  // 这个项目的对话列表(几个分页共用一份，进项目就开始读)读到过就能判断这段对话是谁的、能不能发：不必每次换对话、开分页都再等一个来回。
  // 列表只决定界面开关；发消息、切权限、停止在服务端逐次核对。
  const metadataReady = !cloud.accountMode || chat.history.loaded || metadataReadyKey === metadataKey;
  const creatorReadOnly = controlPolicy.creatorReadOnly;
  const canSwitchVisibility = controlPolicy.canSwitchVisibility;
  useEffect(() => { setTabBusy(tabId, streaming); }, [tabId, streaming, isDraft]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);
  useEffect(() => () => { clearQueue(qKey); }, [qKey]);

  useEffect(() => {
    if (!cloud.accountMode) return;
    let live = true;
    setMetadataReadyKey("");
    setControlNote(null);
    if (controlPendingRef.current && !controlScopeGuardRef.current.isCurrent(controlPendingRef.current.scope)) {
      controlPendingRef.current = null;
      setControlPending(null);
    }
    // 两秒内读回来过的直接用(切分页、换对话时常见)，不再等一个来回
    void chat.history.refresh(false, 2000).then(ok => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, chat.history.refresh, metadataKey]);

  // 新建的云端对话首次落地消息后才出现在服务器列表里；刷新会话元数据时确认其真实所有者与权限。
  const hasMessages = chat.messages.length > 0;
  useEffect(() => {
    if (!cloud.accountMode || !hasMessages) return;
    let live = true;
    // 断着网时(比如刚排了一条等网络恢复的)静默读:读不到不弹「连不上」,发消息这件事不报错(2026-10-22 用户定)
    void chat.history.refresh(chat.outbox.offline()).then(ok => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.accountMode, consent.accepted, chat.conversationId, hasMessages, chat.history.refresh, metadataKey]);

  // 创建者关了开关:成员列表通知过来的(`cloud.enabled`)或 info 报的
  const off = !cloud.enabled || chat.info?.enabled === false;
  const offText = cloudErrorText("disabled");

  /* ---------- 草稿、排队、发送 ---------- */
  const [inputText, setInputText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 开始页(本项目一个会话都没有):消息区换成 StartHero;点预设往输入框放那句话,点发送才把占位页变成第一个会话(云端是新建云端对话)
  const start = useStartPage(tabId, inputText, setInputText, () => { requestAnimationFrame(() => textareaRef.current?.focus()); }, chat.messages.length > 0);
  // 这个项目只给了只读权限(游客):输入区整个置灰(Composer 的 readOnly),发送路径也在 handleSend 里兜底
  const ro = useReadOnly();
  // 游客每个项目只能开一个对话（2026-10-23 用户定）：他已经有一个了，「新对话」入口置灰、说明写在悬停和提示条里；
  // 此刻看的还是一段没发过的新对话（回来时记不得上次的那个、列表里没有它），输入区也置灰、指到「对话历史」去接着聊那一个。
  // 真正拦的是服务端（`guest-chat-limit`），这里只是不让他白写一段话
  const guestChatFull = cloud.accountMode && chat.history.guest && chat.history.atLimit;
  const guestNoNewChat = guestChatFull && !chat.history.items.some((x) => x.id === chat.conversationId);
  /* 附件:选文件 → 逐个上传到云端这个对话的工作目录(显示上传中)→ 发消息时把传好的带上。失败给出原因,可点一下重试、可移除 */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 附件占位 id → 原始文件(失败重试用)与进行中的上传(移除时取消) */
  const retryFilesRef = useRef<Map<string, File>>(new Map());
  /** 附件放进素材库的结果,按附件卡的 id 记:同一条消息重发不重复放、请求内容也不变(文档服务按请求号核内容) */
  const libraryRef = useRef<Map<string, LibraryOutcome>>(new Map());
  const withLibrary = async (files: ChatAttachment[]): Promise<ChatAttachment[]> => {
    const out: ChatAttachment[] = [];
    for (const a of files) {
      const file = a.id ? retryFilesRef.current.get(a.id) : undefined;
      if (!a.id || !file || !LIBRARY_KINDS.includes(a.kind)) { out.push(a); continue; }
      let got = libraryRef.current.get(a.id);
      if (!got) { got = await putInLibrary(file); libraryRef.current.set(a.id, got); }
      out.push({ ...a, ...got });
    }
    return out;
  };
  const uploadsRef = useRef<Map<string, AbortController>>(new Map());
  useEffect(() => {
    if (!cloud.accountMode) return;
    setInputText("");
    setAttachments([]);
    for (const upload of uploadsRef.current.values()) upload.abort();
    uploadsRef.current.clear(); retryFilesRef.current.clear(); libraryRef.current.clear();
  }, [cloud.accountMode, qKey]);
  // 换了对话(新对话、历史里点了别的、进入时自动接上在跑的):附件只在传去的那个对话的工作目录里,不跟过去
  useEffect(() => {
    setAttachments((prev) => {
      const keep = prev.filter((a) => !a.conversationId || a.conversationId === chat.conversationId);
      if (keep.length === prev.length) return prev;
      for (const a of prev) if (!keep.includes(a) && a.id) { uploadsRef.current.get(a.id)?.abort(); uploadsRef.current.delete(a.id); retryFilesRef.current.delete(a.id); }
      return keep;
    });
  }, [chat.conversationId]);
  useEffect(() => () => { for (const ac of uploadsRef.current.values()) ac.abort(); }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { view: viewMode, showThinking } = useViewPrefs();
  const installJobs = useInstallJobs();
  const queue = useQueue(qKey);

  // 预览右键卡片、时间轴右键片段或叠加卡的「引用到 AI」:与本机 AI 栏同一个事件(editor/quoteBus.ts)
  useEffect(() => {
    const onQuote = (ev: Event) => {
      if (!active) return;
      const q = readQuote(ev);
      if (!q) return;
      const ref = q.token + " ";
      const ta = textareaRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : -1;
      setInputText((prev) => {
        const at = pos >= 0 ? pos : prev.length;
        const before = prev.slice(0, at);
        const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
        return before + lead + ref + prev.slice(at);
      });
    };
    window.addEventListener("pc-quote-clip", onQuote as EventListener);
    return () => window.removeEventListener("pc-quote-clip", onQuote as EventListener);
  }, [active]);

  // 「发送失败」气泡上的「重新发送」(UserBubble 发出的事件,带气泡号):是这一页待发清单里的才接
  const resendRef = useRef(chat.outbox.resend);
  resendRef.current = chat.outbox.resend;
  useEffect(() => {
    const onResend = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      if (typeof id === "string" && stillCurrent()) resendRef.current(id);
    };
    window.addEventListener(CLOUD_RESEND_EVENT, onResend as EventListener);
    return () => window.removeEventListener(CLOUD_RESEND_EVENT, onResend as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 刚发出去、服务端的 user 事件还没回来的那一小会儿也算忙(免得连发两条撞上「对话还有一轮在进行」) */
  const echoWait = useRef(false);
  const echoTimer = useRef<number | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    if (view.streaming && echoWait.current) { echoWait.current = false; bump((n) => n + 1); }
  }, [view.streaming]);
  const busy = () => view.streaming || echoWait.current;
  const markSent = () => {
    echoWait.current = true;
    if (echoTimer.current !== null) window.clearTimeout(echoTimer.current);
    echoTimer.current = window.setTimeout(() => { echoWait.current = false; bump((n) => n + 1); }, 4000);
  };
  useEffect(() => () => { if (echoTimer.current !== null) window.clearTimeout(echoTimer.current); }, []);

  const sendNow = async (text: string, files?: ChatAttachment[], staged?: string | null, consentPermit?: CloudConsentPermit | null,
    opts?: { queueOnNetwork?: boolean }): Promise<boolean> => {
    if (off || !stillCurrent() || !controlPolicy.canSend || view.revoked) { if (staged) chat.failStaged(staged, "现在不能在这个对话里发消息。"); return false; }
    if (!cloud.accountMode) markSent();
    // 账号模式:图片、视频、音频附件先放进素材库,告诉 Agent 是哪一条(2026-10-18 用户定)
    const prepared = cloud.accountMode && files?.length ? await withLibrary(files) : files;
    if (!stillCurrent()) return false;
    const ok = await chat.send(text, prepared, staged ?? undefined, consentPermit, opts);
    if (!stillCurrent()) return false;
    if (!ok) { echoWait.current = false; bump((n) => n + 1); }
    return ok;
  };

  const handleSend = async (text: string) => {
    // 这个项目只给了只读权限(游客):不能给云端 Agent 发消息。输入区已置灰(Composer),这是别的发送路径(排队、重发)的兜底
    if (memberReadOnlyNow()) return;
    if (creatorReadOnly || view.revoked || (!text.trim() && attachments.length === 0)) return;
    if (off) return;
    // 开始页上点发送:这时才建第一个会话,这条消息在里面发出去
    start.commit();
    if (cloud.accountMode && text.trim()) {
      // 账号模式:点发送当场在对话里出气泡、清空输入框(乐观显示,2026-10-19 用户要求);告知确认、放进素材库、发送都在后面做,
      // 没发出去时气泡标「没有发出去」并写原因,原文放回输入框(框里此刻是空的才放)。云端收下前气泡只写「发送中…」,不显示成已发送
      const { usable, skipped } = pickSendable(attachments, chat.conversationId);
      const sentAttachments = attachments;
      const staged = chat.stage(text, usable);
      setInputText(previous => previous === text ? "" : previous);
      setAttachments(previous => previous === sentAttachments ? [] : previous);
      const restore = () => {
        if (!stillCurrent()) return;
        setInputText(previous => previous ? previous : text);
        setAttachments(previous => previous.length ? previous : sentAttachments);
      };
      // 断网了,或这个对话里已经有排着等网络的(新发的排在它后面,顺序不乱):不报错,排着,网络恢复后自动发出
      if (staged && (chat.outbox.offline() || chat.outbox.mustQueue()) && chat.outbox.enqueue(text.trim(), usable, staged)) {
        if (skipped > 0) chat.notify(`${skipped} 个附件还在上传或上传失败,这次没带上。`);
        return;
      }
      const admission = await consentForUse({ queueable: Boolean(staged) });
      if (admission && "queue" in admission) {
        if (staged && stillCurrent() && chat.outbox.enqueue(text.trim(), usable, staged)) return;
        if (staged) chat.failStaged(staged, "使用云端 Agent 前，请先阅读并确认告知。");
        restore();
        return;
      }
      if (!admission || !stillCurrent()) {
        if (staged) chat.failStaged(staged, "使用云端 Agent 前，请先阅读并确认告知。");
        restore();
        return;
      }
      if (skipped > 0) chat.notify(`${skipped} 个附件还在上传或上传失败,这次没带上。`);
      if (!await sendNow(text.trim(), usable, staged, admission.permit, { queueOnNetwork: true })) restore();
      return;
    }
    const admission = await consentForUse();
    if (!admission || "queue" in admission || !stillCurrent()) return;
    // 还在上传或上传失败的附件这次先不带上,但发送本身不被挡住
    const { usable, skipped } = pickSendable(attachments, chat.conversationId);
    if (!text.trim()) {
      // 服务端不收空消息:只有附件时留在输入框里,等用户写一句话
      chat.notify(skipped > 0 && usable.length === 0 ? `${skipped} 个附件还在上传或上传失败,请等它传好、或重试后再发。` : CLOUD_ATTACH_NEED_TEXT);
      return;
    }
    if (skipped > 0) chat.notify(`${skipped} 个附件还在上传或上传失败,这次没带上。`);
    if (!cloud.accountMode && busy()) {
      enqueue(qKey, { text: text.trim(), ...(usable.length ? { attachments: usable } : {}) });
    } else {
      if (!await sendNow(text.trim(), usable, null, admission.permit)) return;
    }
    if (stillCurrent()) {
      setInputText(previous => previous === text ? "" : previous);
      setAttachments(previous => previous === attachments ? [] : previous);
    }
  };

  // 一轮结束:空闲且没暂停就发队首
  const flushingRef = useRef(false);
  useEffect(() => {
    if (cloud.accountMode) return;
    if (view.streaming || echoWait.current || off) return;
    if (queue.paused || queue.items.length === 0) return;
    if (flushingRef.current) return;
    const head = queue.items[0];
    flushingRef.current = true;
    void (async () => {
      try {
        const admission = await consentForUse();
        if (!admission || "queue" in admission || !stillCurrent()) { setQueuePaused(qKey, true); return; }
        if (await sendNow(head.text, head.attachments, null, admission.permit)) removeQueued(qKey, head.id);
        else setQueuePaused(qKey, true);
      } finally { flushingRef.current = false; }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.streaming, queue.items, queue.paused, off]);

  const applyCloudControl = async (request: CloudControlRequest) => {
    if (!cloud.accountMode || !isCurrentControl(request) || request.conversationId !== chat.conversationId || controlInFlightRef.current) return;
    if (controlPendingRef.current && controlPendingRef.current.requestId !== request.requestId) return;
    controlInFlightRef.current = request.requestId;
    controlPendingRef.current = request;
    setControlPending(request);
    setControlNote(request.kind === "visibility" ? "正在更新对话权限…" : "正在向云端提交停止请求…");
    try {
      if (request.kind === "visibility") await chat.switchVisibility(request.target, request.requestId);
      else await chat.abort(request.runId, request.requestId);
      if (!isCurrentControl(request)) return;
      const refreshed = await chat.history.refresh();
      if (!isCurrentControl(request)) return;
      if (refreshed) setMetadataReadyKey(metadataKey);
      controlPendingRef.current = null;
      setControlPending(null);
      setControlNote(request.kind === "visibility"
        ? request.target === "private" ? "已切为私有。" : "已切为共有。"
        : "云端已确认停止请求。正在同步对话状态。");
    } catch (error) {
      if (!isCurrentControl(request)) return;
      // 重读可见性；503/fence pending 时保留原请求号，让用户安全重试同一操作。
      const refreshed = await chat.history.refresh();
      if (!isCurrentControl(request)) return;
      if (refreshed) setMetadataReadyKey(metadataKey);
      const pending = error instanceof CloudError && (error.status >= 500 || error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable");
      if (pending) {
        controlPendingRef.current = request;
        setControlPending(request);
        setControlNote(error instanceof CloudError && error.code === "agent-fence-pending"
          ? "已禁止新访问，相关服务关闭待确认。点击重试会沿用原请求。"
          : "云端尚未确认这项操作。状态已重读；点击重试会沿用原请求。");
      } else {
        controlPendingRef.current = null;
        setControlPending(null);
        setControlNote(error instanceof Error ? error.message : "云端控制请求失败，请重读对话状态。");
      }
    } finally {
      if (isCurrentControl(request) && controlInFlightRef.current === request.requestId) controlInFlightRef.current = null;
    }
  };

  const handleVisibilityToggle = () => {
    const pending = controlPendingRef.current;
    if (pending) {
      if (pending.kind === "visibility" && isCurrentControl(pending)) void applyCloudControl(pending);
      return;
    }
    if (!canSwitchVisibility || !currentMeta) return;
    void applyCloudControl({ kind: "visibility", target: currentMeta.visibility === "private" ? "shared" : "private",
      conversationId: chat.conversationId, requestId: crypto.randomUUID(), scope: controlScope });
  };

  const handleStop = () => {
    if (cloud.accountMode) {
      const pending = controlPendingRef.current;
      if (pending) {
        if (pending.kind === "stop" && isCurrentControl(pending)) void applyCloudControl(pending);
        return;
      }
      if (!canStopCurrentRun || !currentRunId) return;
      void applyCloudControl({ kind: "stop", runId: currentRunId, conversationId: chat.conversationId,
        requestId: crypto.randomUUID(), scope: controlScope });
      return;
    }
    if (getQueue(qKey).length > 0) setQueuePaused(qKey, true);
    void chat.abort();
  };

  const insertQueued = async (item: QueuedItem) => {
    const admission = await consentForUse();
    if (!admission || "queue" in admission || !stillCurrent()) return;
    if (view.streaming) {
      await chat.abort();
      // 停止要等服务端收尾的事件回来
      for (let i = 0; i < 40 && stillCurrent() && chat.store.get().some((m) => m.pending); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (!stillCurrent()) return;
    // 中间可能等过停止收尾，许可多半已过期；过期时 chat.send 会照旧再读一次
    if (await sendNow(item.text, item.attachments, null, admission.permit)) removeQueued(qKey, item.id);
    else setQueuePaused(qKey, true);
  };
  const editQueued = (item: QueuedItem) => {
    removeQueued(qKey, item.id);
    setInputText(item.text);
    setAttachments(item.attachments ?? []);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const resumeQueue = () => setQueuePaused(qKey, false);
  const hasDraft = () => inputText.trim().length > 0 || attachments.length > 0;

  /** 真正上传:不 await 丢出去跑,跑完回填那张附件卡(保留占位 id,重试与移除还对得上) */
  const runUpload = (id: string, file: File) => {
    if (!stillCurrent()) return;
    const convId = chat.conversationId;
    const ac = new AbortController();
    uploadsRef.current.set(id, ac);
    chat.attach(file, ac.signal).then(
      (info) => {
        if (!stillCurrent()) return;
        uploadsRef.current.delete(id);
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, url: info.url, name: info.name, kind: info.kind, bytes: info.size, ...(info.text !== undefined ? { text: info.text } : {}), conversationId: convId, status: "ready" as const, error: undefined } : a)));
      },
      (err: unknown) => {
        if (!stillCurrent()) return;
        uploadsRef.current.delete(id);
        if (ac.signal.aborted) return;
        const msg = err instanceof CloudError ? err.message : cloudErrorText("network");
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "error" as const, error: msg } : a)));
      },
    );
  };
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (files.length === 0 || off || creatorReadOnly) return;
    const admitted = await consentForUse();
    if (!stillCurrent()) return;
    for (const file of files) {
      const id = newCloudAttachId();
      retryFilesRef.current.set(id, file);
      setAttachments((prev) => [...prev, { id, url: "", name: file.name, kind: cloudAttachKindOfName(file.name), bytes: file.size,
        srcPath: null, conversationId: chat.conversationId, status: admitted ? "importing" as const : "error" as const,
        ...(!admitted ? { error: "请先确认云端 Agent 告知，再重试上传。" } : {}) }]);
      if (admitted) runUpload(id, file);
    }
  };
  const retryAttachment = (id: string) => {
    const file = retryFilesRef.current.get(id);
    if (!file) return;
    void consentForUse().then(admitted => {
      if (!admitted || !stillCurrent()) return;
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "importing" as const, error: undefined, conversationId: chat.conversationId } : a)));
      runUpload(id, file);
    });
  };
  const removeAttachment = (idx: number) => {
    setAttachments((prev) => {
      const gone = prev[idx];
      if (gone?.id) { uploadsRef.current.get(gone.id)?.abort(); uploadsRef.current.delete(gone.id); retryFilesRef.current.delete(gone.id); }
      return prev.filter((_, i) => i !== idx);
    });
  };

  /* ---------- 消息行的展开状态(同 AiPanel) ---------- */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const handlersRef = useRef({
    toggleTool: (_k: string) => {},
    toggleChip: (_k: string) => {},
    toggleRun: (_k: string) => {},
  });
  handlersRef.current = {
    toggleTool: (key) => setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; }),
    toggleChip: (key) => setExpanded((prev) => (prev.has(key) ? new Set() : new Set([key]))),
    toggleRun: (key) => {
      if (openRuns.has(key)) setExpanded(new Set());
      setOpenRuns((prev) => { const n = new Set(prev); if (!n.delete(key)) n.add(key); return n; });
    },
  };
  const rowHandlers = useMemo(() => ({
    toggleTool: (k: string) => handlersRef.current.toggleTool(k),
    toggleChip: (k: string) => handlersRef.current.toggleChip(k),
    toggleRun: (k: string) => handlersRef.current.toggleRun(k),
  }), []);
  /** 「Agent 操作」显示哪一轮:缺省最新一轮,点气泡切过去 */
  const round = useRoundSelection(chat.messages);

  /* ---------- 诊断报告(〔用户 2026-10-07 定〕云端下照常能用) ----------
   * 在页面里由这段云端对话的事件重建出的消息、会话状态与客户端信息生成,不请求任何 `/api/*`,不含票据、委托与模型 Key。
   * 在线页面「保存为文件」是浏览器下载,桌面版沿用本机写盘;提交走与本机相同的收报告地址(没配就置灰并说明)。 */
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagReport, setDiagReport] = useState("");
  const openDiagnostics = () => {
    if (chat.messages.length === 0) return;
    setDiagReport(cloudConversationReport({
      messages: chat.messages,
      conversationId: chat.conversationId,
      projectId: cloud.projectId,
      serviceUrl: cloud.url,
      view,
      info: chat.info,
      model: chat.model,
      effort: chat.effort,
      notice: chat.notice,
      client: {
        mode: ONLINE_BUILD ? "online" : "desktop",
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
        language: typeof navigator === "undefined" ? undefined : navigator.language,
        platform: typeof navigator === "undefined" ? undefined : (navigator as { platform?: string }).platform,
        viewport: typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        codeVersion: getBuildInfo().codeVersion,
      },
    }));
    setDiagOpen(true);
  };

  /* ---------- 删除对话（2026-10-12 用户定：开对话的人删自己的，创建者删任何人的；先确认；有任务在跑先停再删） ---------- */
  const [deleteAsk, setDeleteAsk] = useState<CloudDeleteAsk | null>(null);
  const canDeleteChat = (item: CloudChatItem) => cloud.accountMode && !!cloud.accountId &&
    (item.ownerAccountId === cloud.accountId || creator);
  const askDelete = (item: CloudChatItem) => {
    if (!canDeleteChat(item)) return;
    setDeleteAsk({ item, requestId: crypto.randomUUID(), stage: "confirm", text: null, others: item.ownerAccountId !== cloud.accountId });
  };
  const confirmDelete = async () => {
    const ask = deleteAsk;
    if (!ask || ask.stage === "working" || !stillCurrent()) return;
    setDeleteAsk({ ...ask, stage: "working", text: null });
    try {
      await chat.removeChat(ask.item.id, ask.requestId);
      if (!stillCurrent()) return;
      setDeleteAsk(null);
      pushToast(CLOUD_CHAT_TEXT.deleteDone, "info");
    } catch (error) {
      if (!stillCurrent()) return;
      // 任务还没停稳(503 agent-fence-pending)或云端暂时没确认：对话还在，用同一个请求号重试
      // 5xx 一类(含删除办成了但云端清理出错的 purge-failed)也是可重试的，但话要贴切：只有围栏没办完才说「任务还没完全停下」
      const retryable = error instanceof CloudError && (error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable" || error.status >= 500);
      const fencePending = error instanceof CloudError && (error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable");
      setDeleteAsk({ ...ask, stage: retryable ? "pending" : "error",
        text: error instanceof CloudError ? (fencePending ? CLOUD_CHAT_TEXT.deletePending : error.message) : cloudErrorText("network") });
      void chat.history.refresh();
    }
  };

  // 删到一半(任务还没停稳)就关了页面的：这位账号再打开页面时静默接着办，不等他再去点「继续删除」(2026-10-13 用户定：不给取消删除)。
  // 文档服务那边任务一结清也会自己收尾(conversation-authority.mjs 的 completePendingDeletions)，这里只是让本页尽快看到结果。
  // 规矩(审查 6)：同一个对话沿用同一个请求号、同时只有一次在途、失败退避(10 秒起翻倍，封顶 5 分钟)、登录失效就停、页面不可见不办；
  // 同一个账号开了几个页签时，别的页签 20 秒内办过的这次就不办(localStorage 里留一个时间戳)。
  const removeChatRef = useRef(chat.removeChat);
  removeChatRef.current = chat.removeChat;
  const resumeRef = useRef(new Map<string, Poller>());
  const resumeTabRef = useRef(crypto.randomUUID());
  const deleteAskId = deleteAsk?.item.id ?? null;
  useEffect(() => {
    if (!cloud.accountMode || !cloud.accountId) return;
    const wanted = new Set(chat.history.items.filter((i) => i.deleting && i.deletingBy === cloud.accountId && i.id !== deleteAskId).map((i) => i.id));
    for (const [id, poller] of resumeRef.current) if (!wanted.has(id)) { poller.stop(); resumeRef.current.delete(id); }
    for (const id of wanted) {
      if (resumeRef.current.has(id)) continue;
      const requestId = crypto.randomUUID();
      const stampKey = `pc.cloudResume:${cloud.projectId}:${id}`;
      const poller = createPoller({ baseMs: 10_000, maxMs: 300_000, run: async () => {
        try { const at = JSON.parse(localStorage.getItem(stampKey) ?? "null"); if (at && at.tab !== resumeTabRef.current && Date.now() - at.t < 20_000) return; } catch { /* 读不了就照办 */ }
        try { localStorage.setItem(stampKey, JSON.stringify({ tab: resumeTabRef.current, t: Date.now() })); } catch { /* 写不了就照办 */ }
        try { await removeChatRef.current(id, requestId); } catch (error) {
          if (error instanceof CloudError && (error.status === 401 || error.status === 403)) return "stop";
          throw error;
        }
        return "stop";
      } });
      resumeRef.current.set(id, poller);
      poller.start();
    }
  }, [cloud.accountMode, cloud.accountId, cloud.projectId, chat.history.items, deleteAskId]);
  useEffect(() => () => { for (const poller of resumeRef.current.values()) poller.stop(); resumeRef.current.clear(); }, []);

  /* ---------- 历史列表 ---------- */
  const openHistory = () => { setHistoryOpen(true); void chat.history.refresh(); };
  const historyItems = useMemo(() => {
    // 当前对话刚发出第一条、服务端列表还没刷新时,先把它列进去
    const hit = chat.history.items.some((x) => x.id === chat.conversationId);
    // 只算云端已经有的消息：点发送当场放的本地气泡(还在发、没发出去的，sendState)不算，没发出去的对话不能先列进历史
    const landed = chat.messages.filter((m) => !m.sendState || m.id.startsWith("cq-"));
    if (hit || landed.length === 0) return chat.history.items;
    const title = landed.find((m) => m.role === "user")?.text.slice(0, 40) || "云端对话";
    return [{ id: chat.conversationId, title, updatedAt: Date.now(), state: streaming ? "running" as const : "idle" as const, lastSeq: view.lastSeq }, ...chat.history.items];
  }, [chat.history.items, chat.conversationId, chat.messages, streaming, view.lastSeq]);

  const connLabel = view.connection === "live" ? "已连接云端" : view.connection === "connecting" ? "正在连接云端…" : view.connection === "reconnecting" ? "连接中断,重新连接中…" : "未连接云端";

  return (
    <aside className="panel panel-right ai-panel pc-cloud-panel" data-pc="cloud-ai-panel" data-cloud-running={streaming ? "1" : "0"} data-cloud-can-stop={canStopCurrentRun ? "1" : "0"} data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
      <CloudAgentConsentDialog open={active && consentOpen && cloud.accountMode && Boolean(consent.accountId) && consent.accountId === cloud.accountId} pending={consent.pending} error={consentError}
        onAccept={acceptConsent} onReject={() => { setConsentError(null); setConsentOpen(false); }} />
      <ChatHeader
        title={tabTitle}
        mcpConnected={view.connection === "live"}
        statusLabel={connLabel}
        showThinking={showThinking}
        onChangeShowThinking={setShowThinking}
        onOpenHistory={openHistory}
        onOpenSetup={() => {}}
        settingsDisabled="云端 Agent 的模型由托管方配置,这里没有 AI 设置可改"
      />

      {!cloud.available && <div className="ai-banner" data-pc="cloud-unavailable">这个项目所在的托管端没有云端 Agent 服务。</div>}
      {cloud.available && off && <div className="ai-banner" data-pc="cloud-off">{offText}</div>}
      {cloud.accountMode && cloud.available && off && creator && <button type="button" data-pc="cloud-agent-enable" disabled={enabling}
        onClick={() => { setEnabling(true); void setAccountAgentEnabled(true).catch(error => chat.notify(error instanceof Error ? error.message : '暂时无法开启云端 Agent。')).finally(() => setEnabling(false)); }}>开启云端 Agent</button>}
      {view.connection === "reconnecting" && (
        <div className="ai-banner pc-cloud-reconnect" data-pc="cloud-reconnecting">
          和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。
        </div>
      )}

      {cloud.accountMode && (
        <div className="pc-cloud-controls" data-pc="cloud-conversation-controls" data-visibility={view.revoked ? "revoked" : (currentMeta?.visibility ?? "unknown")}>
          {view.revoked ? (
            <span className="pc-cloud-access-label is-revoked" data-pc="cloud-visibility-label">
              已无读取权限
            </span>
          ) : !metadataReady ? <span data-pc="cloud-permission-loading">正在读取对话权限…</span> : currentMeta ? <>
            <span className="pc-cloud-access-label" data-pc="cloud-visibility-label">
              {currentMeta.visibility === "private" ? "私有对话" : "共有对话"}{creatorReadOnly ? " · 项目创建者只读" : ""}
            </span>
            {canSwitchVisibility && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-visibility-toggle"
              disabled={visibleControlPending?.kind === "stop"}
              onClick={handleVisibilityToggle}>
              {visibleControlPending?.kind === "visibility"
                ? `重试设为${visibleControlPending.target === "private" ? "私有" : "共有"}`
                : currentMeta.visibility === "private" ? "设为共有" : "设为私有"}
            </button>}
          </> : <span className="pc-cloud-access-label" data-pc="cloud-new-conversation">新云端对话 · 默认共有</span>}
          {controlNote && <span className="pc-cloud-control-note" data-pc="cloud-control-status" role="status">{controlNote}</span>}
          {visibleControlPending?.kind === "stop" && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-stop-retry"
            onClick={() => visibleControlPending && void applyCloudControl(visibleControlPending)}>重试停止请求</button>}
        </div>
      )}

      <RemoteAgentsStrip />
      {start.draft ? (
        <StartHero animated={start.animated} onPickPreset={start.pickPreset} />
      ) : (
        <MessageList
          messages={chat.messages}
          senders={view.senders}
          view={viewMode}
          showThinking={showThinking}
          installJobs={installJobs}
          expanded={expanded}
          openRuns={openRuns}
          rowHandlers={rowHandlers}
          onPickExample={setInputText}
          selectedRound={round.id}
          onSelectRound={round.select}
        />
      )}

      {/* 「Agent 操作」:这个对话按轮显示的操作与汇报(取代按项目频道列的「Agent 操作记录」,2026-10-20 用户定) */}
      <AgentActivityPanel messages={chat.messages} selectedId={round.id} onSelect={round.select} view={viewMode}
        installJobs={installJobs} expanded={expanded} on={rowHandlers} />
      <ThinkingStrip messages={chat.messages} streaming={streaming} />
      {cloud.accountMode ? <CloudQueueList queue={view.queue} messages={chat.messages} senders={view.senders} executorMounted={chat.info?.executorMounted === true} /> :
        <QueueList tabId={qKey} running={view.streaming} onInsert={insertQueued} onEdit={editQueued} onResume={resumeQueue} hasDraft={hasDraft} />}

      {cloud.accountMode && chat.messages.some(m => m.role === 'assistant' && m.pending && (m.progress?.waitingJobs || m.progress?.phase === 'waiting_jobs')) &&
        (!view.queue?.items?.filter(item => item.state === 'queued').length) && (
        <div className="ai-banner pc-cloud-waiting-jobs" data-pc="cloud-waiting-jobs">
          上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。
        </div>
      )}

      {cloud.accountMode && chat.messages.some(m => m.role === 'assistant' && m.pending && ((m.progress as Record<string, any>)?.renderQueuePosition || m.progress?.phase === 'render_queued')) &&
        (!view.queue?.items?.filter(item => item.state === 'queued').length) && (
        <div className="ai-banner pc-cloud-render-queued" data-pc="cloud-render-queued">
          云端渲染正在给别的项目用，排在第 {(chat.messages.find(m => m.role === 'assistant' && m.pending && ((m.progress as Record<string, any>)?.renderQueuePosition || m.progress?.phase === 'render_queued'))?.progress as Record<string, any>)?.renderQueuePosition ?? 1} 位，轮到了会接着做。
        </div>
      )}

      {cloud.accountMode && chat.history.atLimit && !chat.history.items.some((x) => x.id === chat.conversationId) && (
        <div className="ai-banner" data-pc={chat.history.guest ? "cloud-guest-chat-limit" : "cloud-limit-note"} role="status">
          {chat.history.guest ? CLOUD_CHAT_TEXT.guestLimit : CLOUD_CHAT_TEXT.limitComposer}
        </div>
      )}
      {chat.notice && (
        <div className="ai-toast" data-pc="cloud-notice" role="alert" onClick={chat.clearNotice} title="点一下关掉">{chat.notice}</div>
      )}
      <div className="pc-cloud-note" data-pc="cloud-note">{cloud.accountMode && chat.info?.executorMounted !== true ? '消息会持久排队，等待执行服务；重新打开可接着看。' : '在云端运行,关闭后继续;重新打开可接着看'}</div>

      {creatorReadOnly ? <div className="pc-cloud-readonly" data-pc="cloud-readonly-note">
        项目创建者可以查看这段私有对话，但不能发送消息。
        {canStopCurrentRun && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-stop-readonly" onClick={handleStop}>停止当前一轮</button>}
      </div> : !metadataReady ? <div className="pc-cloud-readonly" data-pc="cloud-permission-wait">正在确认对话权限，确认前暂不能发送。</div> : <Composer
        text={inputText}
        onTextChange={setInputText}
        textareaRef={textareaRef}
        attachments={attachments}
        uploading={false}
        disabled={Boolean(view.revoked) || guestNoNewChat}
        disabledReason={view.revoked ? "当前账号已无法读取这个对话，请重新选择有权限的对话。" : guestNoNewChat ? CLOUD_CHAT_TEXT.guestLimit : undefined}
        readOnly={ro.locked}
        readOnlyReason={ro.why}
        onPickFiles={() => fileInputRef.current?.click()}
        onRetryAttachment={(id) => retryAttachment(id)}
        onRemoveAttachment={removeAttachment}
        onSubmit={handleSend}
        onStop={handleStop}
        canStop={cloud.accountMode ? canStopCurrentRun : undefined}
        stopDisabledReason={cloud.accountMode && !canStopCurrentRun ? "只能停止自己发起的任务" : undefined}
        streaming={streaming}
        hotkeysOff={props.hotkeysOff}
        active={active}
        provider={desktop?.provider ?? null}
        providers={desktop?.providers ?? []}
        onSetProvider={() => {}}
        config={desktop?.config ?? null}
        tabId={tabId}
        guide={start.guide}
        menu={{
          workflowRoles: [],
          onRunWorkflow: () => {},
          canDiagnose: chat.messages.length > 0,
          onOpenDiagnostics: openDiagnostics,
          onNewChat: () => chat.newChat(),
          ...(guestChatFull ? { newChatDisabledReason: CLOUD_CHAT_TEXT.guestLimit } : {}),
        }}
        cloud={{
          show: true,
          selected: true,
          onSelect: () => {},
          onLeave: (p) => { if (desktop) { leaveCloudTab(tabId); desktop.onLeave(p); } },
          toolbar: <CloudModelBar info={chat.info} model={chat.model} onModel={chat.setModel} effort={chat.effort} onEffort={chat.setEffort} disabled={streaming} tabId={tabId} />,
          attachTitle: CLOUD_ATTACH_TITLE,
        }}
      />}
      <input type="file" ref={fileInputRef} data-pc="cloud-attach-input" accept={CLOUD_ATTACH_ACCEPT} multiple style={{ display: "none" }} onChange={handleFileChange} />

      <ReportDialog
        open={diagOpen}
        title="云端对话诊断报告"
        label="云端对话诊断"
        hint="含这段云端对话的过程、出错原因和客户端信息;不含票据、委托、模型 Key 或任何凭证"
        text={diagReport}
        onClose={() => setDiagOpen(false)}
      />
      <CloudDeleteChatDialog ask={deleteAsk} onConfirm={() => { void confirmDelete(); }} onCancel={() => setDeleteAsk(null)} />
      <ChatHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={[]}
        loading={false}
        query={query}
        onQueryChange={setQuery}
        currentId={chat.conversationId}
        onPick={() => {}}
        onDelete={() => {}}
        onNewChat={() => { chat.newChat(); setHistoryOpen(false); }}
        {...(guestChatFull ? { newChatDisabledReason: CLOUD_CHAT_TEXT.guestLimit } : {})}
        hideLocal
        cloud={{ items: historyItems, loading: chat.history.loading, currentId: chat.conversationId, onPick: (id) => { chat.openChat(id); setHistoryOpen(false); },
          ...(cloud.accountMode ? { canDelete: canDeleteChat, onDelete: askDelete, limitReached: chat.history.atLimit, ownedCount: chat.history.ownedCount, limit: chat.history.limit,
            ...(chat.history.guest ? { limitText: CLOUD_CHAT_TEXT.guestLimit } : {}) } : {}) }}
      />
    </aside>
  );
}
