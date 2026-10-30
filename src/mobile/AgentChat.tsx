/**
 * 手机版 Agent 分页里一个会话的对话页(演示稿的 Agent 页:创造力、消息、操作卡片、引用标记条、输入框)。
 *
 * 业务和桌面右栏的云端对话页(`editor/right/CloudAiPanel.tsx`)是同一套:`useCloudChat` 管事件流和发送,
 * 告知确认、对话权限、停止、共有 / 私有、开始页(`useStartPage`)都沿用桌面的做法;只是画法换成演示稿的样子,
 * 并且「引用」不再往输入框里插文字,而是放在输入框上方的标记条里,发送时由 `agentView.withQuotes` 带上。
 * 手机版暂不放的:附件、模型与思考强度下拉、历史对话列表、删除对话、诊断报告(演示稿里没有这些入口,见任务报告)。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import "katex/dist/katex.min.css";
import { useCloudChat, type CloudAgentState } from "../ai/extensions";
import { OUTBOX_RESEND_EVENT } from "../ai/outbox";
import { CloudError, cloudConversationControlPolicy, cloudErrorText } from "../ai/extensions";
import { acceptCloudConsent, cloudConsentState, refreshCloudConsent, subscribeCloudConsent } from "../ai/extensions";
import { setTabBusy, setTabConversation, setTabCreativity, useAgentTabs } from "../ai/agentTabs";
import { projectCreativity } from "../kernel/creativity.mjs";
import { useStore } from "../store/project";
import { setAccountAgentEnabled, useSync } from "../editor/sync/syncManager";
import { CloudAgentConsentDialog } from "../editor/right/CloudAgentConsentDialog";
import { useStartPage } from "../editor/right/chat/StartHero";
import { useToast } from "./ui";
import { AgentChatView } from "./AgentChatView";
import { addQuote, withQuotes, type QuoteRef } from "./agentView";
import { readQuote } from "../editor/quoteBus";

export function AgentChat(props: {
  tabId: string;
  /** 这一页此刻是不是用户看着的那一页(分页开着、会话标签选中) */
  shown: boolean;
  cloud: CloudAgentState;
  /** 各会话此刻有几条消息(关会话前判断要不要确认) */
  counts: MutableRefObject<Map<string, number>>;
}) {
  const { tabId, shown, cloud, counts } = props;
  const toast = useToast();
  const creator = useSync((s) => s.shared?.creator === true);
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // 断网待发(2026-10-22 用户定,同桌面):断网时发的消息排着、网络恢复后核对最近一条用户消息再自动发出
  const chat = useCloudChat({ tabId, cloud, enabled: true, autoAttach: true, outbox: true });
  const { view } = chat;
  const { tabs } = useAgentTabs();
  const tab = tabs.find((t) => t.id === tabId);
  const isDraft = tab?.draft === true;
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const level = tab?.creativity ?? projectLevel;

  const qKey = cloud.accountMode ? `cloud:${tabId}:${cloud.accountId ?? "none"}:${consent.bindingVersion}:${cloud.projectId ?? "none"}` : `cloud:${tabId}`;
  const keyRef = useRef(qKey);
  keyRef.current = qKey;
  const stillCurrent = () => keyRef.current === qKey && (!cloud.accountMode ||
    (cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion));

  /* ---------- 告知确认(同桌面) ---------- */
  useEffect(() => {
    if (!shown || !cloud.accountMode || !cloud.available || !cloud.projectId || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(
      (accepted) => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      (error) => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); },
    );
    return () => { dead = true; };
  }, [shown, cloud.accountMode, cloud.available, cloud.projectId, cloud.accountId, consent.accountId, consent.bindingVersion]);
  useEffect(() => { if (cloud.accountMode) { setConsentOpen(false); setConsentError(null); } }, [cloud.accountMode, qKey]);
  const consentForUse = async (opts?: { queueable?: boolean }): Promise<boolean | "queue"> => {
    if (!cloud.accountMode) return true;
    if (!stillCurrent()) return false;
    const expected = cloud.accountId ? { accountId: cloud.accountId, bindingVersion: consent.bindingVersion } : null;
    if (!expected || consent.accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) {
      setConsentError("请先登录当前项目的账号。");
      toast("请先登录当前项目的账号");
      return false;
    }
    try {
      const accepted = await refreshCloudConsent(expected);
      if (cloudConsentState().accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) return false;
      if (!accepted) { setConsentError(null); setConsentOpen(true); }
      return accepted;
    } catch (error) {
      if (!stillCurrent()) return false;
      // 断网读不到告知:不弹告知框,这条消息排着等网络恢复(恢复后发出之前再核一次告知)
      if (opts?.queueable && chat.outbox.transient(error)) return "queue";
      setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。");
      setConsentOpen(true);
      return false;
    }
  };
  const acceptConsent = () => {
    void acceptCloudConsent().then(
      () => { if (stillCurrent()) { setConsentError(null); setConsentOpen(false); } },
      (error) => { if (stillCurrent()) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); },
    );
  };

  /* ---------- 会话状态:对话号、忙不忙、权限 ---------- */
  useEffect(() => { setTabConversation(tabId, chat.conversationId); }, [tabId, chat.conversationId, isDraft]);
  const currentMeta = chat.history.items.find((item) => item.id === chat.conversationId) ?? null;
  const policy = cloudConversationControlPolicy({
    accountMode: cloud.accountMode, accountId: cloud.accountId, creator, conversation: currentMeta,
    queue: view.queue, senders: view.senders, legacyStreaming: view.streaming,
  });
  const streaming = policy.streaming;
  const currentRunId = policy.currentRunId;
  const creatorReadOnly = policy.creatorReadOnly;
  useEffect(() => { setTabBusy(tabId, streaming); }, [tabId, streaming, isDraft]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);

  const [metadataReadyKey, setMetadataReadyKey] = useState("");
  const metadataKey = `${qKey}:${chat.conversationId}:${cloud.enabled ? "on" : "off"}:${chat.info?.enabled === false ? "off" : "on"}`;
  const metadataReady = !cloud.accountMode || chat.history.loaded || metadataReadyKey === metadataKey;
  useEffect(() => {
    if (!cloud.accountMode) return;
    let live = true;
    setMetadataReadyKey("");
    void chat.history.refresh(false, 2000).then((ok) => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, chat.history.refresh, metadataKey]);
  const hasMessages = chat.messages.length > 0;
  useEffect(() => {
    if (!cloud.accountMode || !hasMessages) return;
    let live = true;
    // 断着网时(比如刚排了一条等网络恢复的)静默读:读不到不弹「连不上」
    void chat.history.refresh(chat.outbox.offline()).then((ok) => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.accountMode, consent.accepted, chat.conversationId, hasMessages, chat.history.refresh, metadataKey]);
  useEffect(() => { counts.current.set(tabId, chat.messages.length); }, [counts, tabId, chat.messages.length]);
  useEffect(() => () => { counts.current.delete(tabId); }, [counts, tabId]);

  const off = !cloud.enabled || chat.info?.enabled === false;
  const [enabling, setEnabling] = useState(false);

  /* ---------- 输入框、引用标记条、开始页 ---------- */
  const [inputText, setInputText] = useState("");
  const [quotes, setQuotes] = useState<QuoteRef[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());
  const start = useStartPage(tabId, inputText, setInputText, focusInput, hasMessages);
  useEffect(() => {
    if (!cloud.accountMode) return;
    setInputText("");
    setQuotes([]);
  }, [cloud.accountMode, qKey]);
  // 输入框随内容长高(最多约五行)
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText, shown]);
  // 选中一项后点「引用」(或预览右键「引用到 AI」):同一个 `pc-quote-clip` 事件,放进标记条而不是输入框
  useEffect(() => {
    if (!shown) return;
    const onQuote = (ev: Event) => {
      const q = readQuote(ev);
      if (!q) return;
      setQuotes((prev) => addQuote(prev, { id: q.id, label: q.label, kind: q.kind }));
      focusInput();
    };
    window.addEventListener("pc-quote-clip", onQuote as EventListener);
    return () => window.removeEventListener("pc-quote-clip", onQuote as EventListener);
  }, [shown]);

  /* ---------- 发送与停止 ---------- */
  // 「发送失败」气泡上的「重新发送」(agentParts 的 UserBubble 发出的事件,带气泡号):是这一页待发清单里的才接
  const resendRef = useRef(chat.outbox.resend);
  resendRef.current = chat.outbox.resend;
  useEffect(() => {
    const onResend = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id;
      if (typeof id === "string" && stillCurrent()) resendRef.current(id);
    };
    window.addEventListener(OUTBOX_RESEND_EVENT, onResend as EventListener);
    return () => window.removeEventListener(OUTBOX_RESEND_EVENT, onResend as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sendNow = async (text: string, staged: string | null, opts?: { queueOnNetwork?: boolean }): Promise<boolean> => {
    if (off || !stillCurrent() || !policy.canSend || view.revoked) {
      if (staged) chat.failStaged(staged, "现在不能在这个对话里发消息。");
      return false;
    }
    const ok = await chat.send(text, undefined, staged ?? undefined, null, opts);
    return stillCurrent() && ok;
  };
  /** 探针与排障的只读口子(同 `window.__pcCloud`):这一页最近一次点发送时的引用和正文,以及引用条此刻的内容 */
  const lastSend = useRef<{ text: string; quotes: QuoteRef[] } | null>(null);
  useEffect(() => {
    const w = window as unknown as { __pcMobileAgent?: Record<string, unknown> };
    w.__pcMobileAgent = { ...(w.__pcMobileAgent ?? {}), [tabId]: { lastSend: () => lastSend.current, quotes: () => quotes } };
    return () => { if (w.__pcMobileAgent) delete w.__pcMobileAgent[tabId]; };
  }, [tabId, quotes]);
  const handleSend = async () => {
    const body = inputText.trim();
    if (!body) { taRef.current?.focus(); return; }
    if (creatorReadOnly || view.revoked) return;
    if (off) { chat.notify(cloudErrorText("disabled")); return; }
    // 已有对话、权限还没读回来:先别发(对话可能是别人的私有对话);新对话没有这个问题,不用等
    if (!metadataReady && hasMessages) { toast("正在确认对话权限,稍等一下再发"); return; }
    // 开始页上点发送:这时才建第一个会话,这条消息在里面发出去
    start.commit();
    const text = withQuotes(body, quotes);
    const sentQuotes = quotes;
    lastSend.current = { text, quotes: sentQuotes };
    const sentInput = inputText;
    if (cloud.accountMode) {
      // 账号模式:点发送当场在对话里出气泡、清空输入框(乐观显示);没发出去时气泡标「没有发出去」,原文放回输入框
      const staged = chat.stage(text);
      setInputText((prev) => (prev === sentInput ? "" : prev));
      setQuotes((prev) => (prev === sentQuotes ? [] : prev));
      const restore = () => {
        if (!stillCurrent()) return;
        setInputText((prev) => prev || body);
        setQuotes((prev) => (prev.length ? prev : sentQuotes));
      };
      // 断网了,或这个对话里已经有排着等网络的(新发的排在它后面,顺序不乱):不报错,排着,网络恢复后自动发出
      if (staged && (chat.outbox.offline() || chat.outbox.mustQueue()) && chat.outbox.enqueue(text, undefined, staged)) return;
      const admitted = await consentForUse({ queueable: Boolean(staged) });
      if (admitted === "queue" && staged && stillCurrent() && chat.outbox.enqueue(text, undefined, staged)) return;
      if (admitted !== true || !stillCurrent()) {
        if (staged) chat.failStaged(staged, "使用云端 Agent 前,请先阅读并确认告知。");
        restore();
        return;
      }
      if (!await sendNow(text, staged, { queueOnNetwork: true })) restore();
      return;
    }
    if (await consentForUse() !== true || !stillCurrent()) return;
    if (view.streaming) { toast("上一轮还在进行,等它结束再发"); return; }
    if (!await sendNow(text, null)) return;
    if (stillCurrent()) {
      setInputText((prev) => (prev === sentInput ? "" : prev));
      setQuotes((prev) => (prev === sentQuotes ? [] : prev));
    }
  };
  /** 同一个操作重试时沿用请求号(云端 503 一类可以安全重试) */
  const reqRef = useRef<{ key: string; id: string } | null>(null);
  const requestId = (key: string) => {
    if (reqRef.current?.key !== key) reqRef.current = { key, id: crypto.randomUUID() };
    return reqRef.current.id;
  };
  const handleStop = async () => {
    if (!cloud.accountMode) { void chat.abort(); return; }
    if (!policy.canStop || !currentRunId) { toast("只能停止自己发起的任务"); return; }
    try {
      await chat.abort(currentRunId, requestId(`stop:${currentRunId}`));
      reqRef.current = null;
      void chat.history.refresh();
    } catch (error) {
      if (stillCurrent()) chat.notify(error instanceof Error ? error.message : "停止请求没有成功,可以再点一次。");
    }
  };
  const toggleVisibility = async () => {
    if (!policy.canSwitchVisibility || !currentMeta) return;
    const target = currentMeta.visibility === "private" ? "shared" : "private";
    try {
      await chat.switchVisibility(target, requestId(`vis:${chat.conversationId}:${target}`));
      reqRef.current = null;
      await chat.history.refresh();
      if (stillCurrent()) toast(target === "private" ? "已切为私有" : "已切为共有");
    } catch (error) {
      if (stillCurrent()) chat.notify(error instanceof CloudError ? error.message : "暂时没能切换,可以再点一次。");
    }
  };

  const queued = view.queue?.items.filter((i) => i.state === "queued").length ?? 0;
  const stopMode = streaming && inputText.trim().length === 0;
  const visLabel = view.revoked ? "已无读取权限" : !metadataReady ? "" : currentMeta ? `${currentMeta.visibility === "private" ? "私有对话" : "共有对话"}${creatorReadOnly ? " · 创建者只读" : ""}` : "新对话 · 默认共有";

  const banners = (
    <>
      {!cloud.available && <div className="note" data-pcm="agent-note">这个项目所在的托管端没有云端 Agent 服务。</div>}
      {cloud.available && off && <div className="note" data-pcm="agent-note">{cloudErrorText("disabled")}
        {cloud.accountMode && creator && <button type="button" className="btn" disabled={enabling} data-pcm="agent-enable"
          onClick={() => { setEnabling(true); void setAccountAgentEnabled(true).catch((e) => chat.notify(e instanceof Error ? e.message : "暂时无法开启云端 Agent。")).finally(() => setEnabling(false)); }}>开启云端 Agent</button>}
      </div>}
      {view.connection === "reconnecting" && <div className="note" data-pcm="agent-note">和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。</div>}
      {chat.notice && <div className="note warn" data-pcm="agent-notice" role="alert" onClick={chat.clearNotice}>{chat.notice}</div>}
    </>
  );

  return (
    <AgentChatView
      tabId={tabId}
      shown={shown}
      who={tab?.title ?? "Agent"}
      messages={chat.messages}
      start={{ draft: start.draft, animated: start.animated, guide: start.guide, onPickPreset: start.pickPreset }}
      level={level}
      levelDisabled={streaming}
      onLevel={(lv) => setTabCreativity(tabId, lv)}
      visLabel={visLabel}
      canToggleVisibility={policy.canSwitchVisibility}
      onToggleVisibility={() => void toggleVisibility()}
      banners={banners}
      queued={queued}
      readOnly={creatorReadOnly}
      quotes={quotes}
      onRemoveQuote={(id) => setQuotes((prev) => prev.filter((q) => q.id !== id))}
      inputText={inputText}
      onInput={setInputText}
      inputRef={taRef}
      inputDisabled={Boolean(view.revoked)}
      onSend={() => void handleSend()}
      onStop={() => void handleStop()}
      stopMode={stopMode}
      onPickExample={(text) => { setInputText(text); focusInput(); }}
      dialog={<CloudAgentConsentDialog open={shown && consentOpen && cloud.accountMode && Boolean(consent.accountId) && consent.accountId === cloud.accountId}
        pending={consent.pending} error={consentError} onAccept={acceptConsent} onReject={() => { setConsentError(null); setConsentOpen(false); }} />}
    />
  );
}
