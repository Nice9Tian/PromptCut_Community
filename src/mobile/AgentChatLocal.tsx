/**
 * Chat page for one session in the mobile app's Agent tab: **the local Agent's copy** (semantics
 * `workflow/editing.md`, section "A second screen on the LAN").
 *
 * It draws the same page as the cloud copy (`AgentChat.tsx`, both hand off to `AgentChatView`);
 * only what sits underneath differs: this one is wired to `useVibeLocal`, which is the AI panel
 * setup of the editor (`src/ai/useAiChat.ts` sends requests, `src/ai/agentTabs.ts` manages tabs).
 * What you say on the phone is executed by **the Agent on the computer** and edits the same
 * project, so both sides see the changes.
 *
 * **But the two sides are not the same conversation**: the phone and the computer are two
 * browsers, and the tab manifest (`agentTabs.ts`) and the messages (`liveChat.ts`, one per tab)
 * live in each page on its own, with no cross-page channel. This version does not archive either
 * (archiving is done by the desktop AI panel `AiPanel.tsx` through `useChatHistory`), so once a
 * session is closed on the phone, that conversation is gone: `AgentPage` asks before closing.
 *
 * Anything the local side lacks is not drawn: with no account there is no "who sent it", no
 * shared / private chat, no disclosure confirmation, and no pending-send when offline (the local
 * Agent runs on this very machine over loopback, so there is no "waiting for the network to
 * recover").
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
  /** Whether this page is the one the user is looking at right now (tab open, session tab selected) */
  shown: boolean;
  projectId: string | null;
  /** How many messages each session has right now (to decide whether to confirm before closing a session) */
  counts: MutableRefObject<Map<string, number>>;
}) {
  const { tabId, shown, projectId, counts } = props;
  const toast = useToast();
  // One is mounted per session (switching tabs does not unmount, the background turn keeps running): so pass the tab id in rather than following the "current tab"
  const vibe = useVibeLocal({ projectId, tabId });
  const { tabs } = useAgentTabs();
  const tab = tabs.find((t) => t.id === tabId);
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const level = tab?.creativity ?? projectLevel;
  const messages = vibe.chat.messages;
  const hasMessages = messages.length > 0;

  /* ---------- Input box, quote bar, start page ---------- */
  const [inputText, setInputText] = useState("");
  const [quotes, setQuotes] = useState<QuoteRef[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());
  const start = useStartPage(tabId, inputText, setInputText, focusInput, hasMessages);

  // The input box grows with its content (up to about five lines), same as the cloud version
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText, shown]);

  // After selecting an item, click "Quote" (or right-click in preview "Quote to AI"): it goes into the bar, no text is inserted into the input box
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

  /* ---------- Session state ---------- */
  useEffect(() => { setTabBusy(tabId, vibe.streaming); }, [tabId, vibe.streaming]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);
  useEffect(() => { counts.current.set(tabId, messages.length); }, [counts, tabId, messages.length]);
  useEffect(() => () => { counts.current.delete(tabId); }, [counts, tabId]);

  /** Read-only hook for probes and troubleshooting, same shape as the cloud version */
  const lastSend = useRef<{ text: string; quotes: QuoteRef[] } | null>(null);
  useEffect(() => {
    const w = window as unknown as { __pcMobileAgent?: Record<string, unknown> };
    w.__pcMobileAgent = { ...(w.__pcMobileAgent ?? {}), [tabId]: { lastSend: () => lastSend.current, quotes: () => quotes, local: true } };
    return () => { if (w.__pcMobileAgent) delete w.__pcMobileAgent[tabId]; };
  }, [tabId, quotes]);

  /* ---------- Send and stop ---------- */
  const handleSend = async () => {
    const body = inputText.trim();
    if (!body) { taRef.current?.focus(); return; }
    if (!vibe.canSend) { if (vibe.whyNot) toast(vibe.whyNot); return; }
    // Click send on the start page: only now is the first session created, and this message is sent inside it
    start.commit();
    const text = withQuotes(body, quotes);
    const sentInput = inputText;
    const sentQuotes = quotes;
    lastSend.current = { text, quotes: sentQuotes };
    // If this page is running, queue; if idle, send directly; decided by `useVibeLocal` (same as the AI panel's "Send")
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
      {/* The local Agent runs on the computer, and closing the app stops this turn —— mention it only before anything has been said, so it does not sit on every page */}
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
      /* Local chat has no shared / private */
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
