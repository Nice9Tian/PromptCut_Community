/**
 * 手机版 Agent 分页里一个会话的对话页 —— **本机 Agent 那一份**（语义 `workflow/editing.md`「局域网里的第二块屏」）。
 *
 * 和云端那一份（`AgentChat.tsx`）画的是同一页（都交给 `AgentChatView`），换的只是底下接谁：
 * 这里接 `useVibeLocal`，也就是编辑界面 AI 栏那一套（`src/ai/useAiChat.ts` 发请求、`src/ai/agentTabs.ts` 管分页）。
 * 手机上说的话由**电脑上那个 Agent** 执行，改的是同一个项目，所以改动两边都看得见。
 *
 * **但两边不是同一段对话**：手机和电脑是两个浏览器，分页清单（`agentTabs.ts`）和消息（`liveChat.ts` 每页一份）
 * 都在各自那张页面里，没有跨页通道。这一版也不归档（归档是电脑 AI 栏 `AiPanel.tsx` 用 `useChatHistory` 做的事），
 * 所以手机上关掉一个会话，这段话就没了 —— 关之前由 `AgentPage` 问一声。
 *
 * 本机没有的东西一概不画：没有账号就没有「谁发的」、没有共有 / 私有、没有告知确认、没有断网待发
 * （本机 Agent 就在这台机器上跑，连的是回环，没有「等网络恢复」这回事）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import "katex/dist/katex.min.css";
import { setTabBusy, setTabCreativity, useAgentTabs } from "../ai/agentTabs";
import { projectCreativity } from "../kernel/creativity.mjs";
import { useStore } from "../store/project";
import { useVibeLocal } from "../start/useVibeLocal";
import { useStartPage } from "../editor/right/chat/StartHero";
import { readQuote } from "../editor/quoteBus";
import { useToast } from "./ui";
import { AgentChatView } from "./AgentChatView";
import { addQuote, withQuotes, type QuoteRef } from "./agentView";

export function AgentChatLocal(props: {
  tabId: string;
  /** 这一页此刻是不是用户看着的那一页（分页开着、会话标签选中） */
  shown: boolean;
  projectId: string | null;
  /** 各会话此刻有几条消息（关会话前判断要不要确认） */
  counts: MutableRefObject<Map<string, number>>;
}) {
  const { tabId, shown, projectId, counts } = props;
  const toast = useToast();
  // 每个会话各挂一份（切标签不卸载，后台那一轮照跑）：所以把页号传进去，不跟着「当前页」走
  const vibe = useVibeLocal({ projectId, tabId });
  const { tabs } = useAgentTabs();
  const tab = tabs.find((t) => t.id === tabId);
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const level = tab?.creativity ?? projectLevel;
  const messages = vibe.chat.messages;
  const hasMessages = messages.length > 0;

  /* ---------- 输入框、引用标记条、开始页 ---------- */
  const [inputText, setInputText] = useState("");
  const [quotes, setQuotes] = useState<QuoteRef[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());
  const start = useStartPage(tabId, inputText, setInputText, focusInput, hasMessages);

  // 输入框随内容长高（最多约五行），同云端那一份
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText, shown]);

  // 选中一项后点「引用」（或预览右键「引用到 AI」）：放进标记条，不往输入框里插字
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

  /* ---------- 会话状态 ---------- */
  useEffect(() => { setTabBusy(tabId, vibe.streaming); }, [tabId, vibe.streaming]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);
  useEffect(() => { counts.current.set(tabId, messages.length); }, [counts, tabId, messages.length]);
  useEffect(() => () => { counts.current.delete(tabId); }, [counts, tabId]);

  /** 探针与排障的只读口子，形状同云端那一份 */
  const lastSend = useRef<{ text: string; quotes: QuoteRef[] } | null>(null);
  useEffect(() => {
    const w = window as unknown as { __pcMobileAgent?: Record<string, unknown> };
    w.__pcMobileAgent = { ...(w.__pcMobileAgent ?? {}), [tabId]: { lastSend: () => lastSend.current, quotes: () => quotes, local: true } };
    return () => { if (w.__pcMobileAgent) delete w.__pcMobileAgent[tabId]; };
  }, [tabId, quotes]);

  /* ---------- 发送与停止 ---------- */
  const handleSend = async () => {
    const body = inputText.trim();
    if (!body) { taRef.current?.focus(); return; }
    if (!vibe.canSend) { if (vibe.whyNot) toast(vibe.whyNot); return; }
    // 开始页上点发送：这时才建第一个会话，这条消息在里面发出去
    start.commit();
    const text = withQuotes(body, quotes);
    const sentInput = inputText;
    const sentQuotes = quotes;
    lastSend.current = { text, quotes: sentQuotes };
    // 这一页在跑就排队、空闲就直发，由 `useVibeLocal` 判（同 AI 栏的「发送」）
    const ok = await vibe.send(text);
    if (!ok) return;
    setInputText((prev) => (prev === sentInput ? "" : prev));
    setQuotes((prev) => (prev === sentQuotes ? [] : prev));
  };
  const handleStop = () => { void vibe.stop(); };
  const stopMode = vibe.streaming && inputText.trim().length === 0;

  const banners = (
    <>
      {vibe.whyNot && <div className="note" data-pcm="agent-note">{vibe.whyNot}</div>}
      {vibe.banner && <div className="note warn" data-pcm="agent-notice" role="alert" onClick={vibe.clearBanner}>{vibe.banner}</div>}
      {/* 本机 Agent 跑在电脑上，关掉软件这一轮就停了 —— 只在还没说过话时提一句，免得每页都压着一条 */}
      {!hasMessages && <div className="note" data-pcm="agent-local-hint">{vibe.hint}</div>}
    </>
  );

  return (
    <AgentChatView
      tabId={tabId}
      shown={shown}
      who={tab?.title ?? "Agent"}
      messages={messages}
      start={{ draft: start.draft, animated: start.animated, guide: start.guide, onPickPreset: start.pickPreset }}
      level={level}
      levelDisabled={vibe.streaming}
      onLevel={(lv) => setTabCreativity(tabId, lv)}
      /* 本机对话没有共有 / 私有 */
      visLabel=""
      canToggleVisibility={false}
      onToggleVisibility={() => {}}
      banners={banners}
      queued={vibe.queued}
      readOnly={false}
      quotes={quotes}
      onRemoveQuote={(id) => setQuotes((prev) => prev.filter((q) => q.id !== id))}
      inputText={inputText}
      onInput={setInputText}
      inputRef={taRef}
      inputDisabled={false}
      onSend={() => void handleSend()}
      onStop={handleStop}
      stopMode={stopMode}
      onPickExample={(text) => { setInputText(text); focusInput(); }}
    />
  );
}
