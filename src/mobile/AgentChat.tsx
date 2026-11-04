/**
 * Chat page of one session in the mobile app's Agent tab (the Agent page of the demo mockup: creativity, messages, action cards, quote bar, input box).
 *
 * The logic is the same as the desktop right rail's cloud chat page (`editor/right/CloudAiPanel.tsx`): `useCloudChat` manages the event stream and sending,
 * and notice confirmation, chat permissions, stop, shared / private, and the start page (`useStartPage`) all follow the desktop's approach; only the rendering is changed to look like the demo mockup,
 * and "quote" no longer inserts text into the input box but goes into the bar above the input box, carried along on send by `agentView.withQuotes`.
 * Not on the mobile app for now: attachments, the model and thinking effort dropdowns, the history chat list, deleting chats, diagnostic reports (the demo mockup has no entry points for these, see the task report).
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
import { tr } from "../i18n/index.ts";

export function AgentChat(props: {
  tabId: string;
  /** Whether this page is the one the user is looking at right now (tab open, session tab selected) */
  shown: boolean;
  cloud: CloudAgentState;
  /** How many messages each session has right now (to decide whether to confirm before closing a session) */
  counts: MutableRefObject<Map<string, number>>;
}) {
  const { tabId, shown, cloud, counts } = props;
  const toast = useToast();
  const creator = useSync((s) => s.shared?.creator === true);
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // Queued while offline (user decision, 2026-10-22, same as desktop): messages sent while offline wait in line, and once the network is back, the latest user message is checked and then sent automatically
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

  /* ---------- Notice confirmation (same as desktop) ---------- */
  useEffect(() => {
    if (!shown || !cloud.accountMode || !cloud.available || !cloud.projectId || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(
      (accepted) => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      (error) => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable.")); },
    );
    return () => { dead = true; };
  }, [shown, cloud.accountMode, cloud.available, cloud.projectId, cloud.accountId, consent.accountId, consent.bindingVersion]);
  useEffect(() => { if (cloud.accountMode) { setConsentOpen(false); setConsentError(null); } }, [cloud.accountMode, qKey]);
  const consentForUse = async (opts?: { queueable?: boolean }): Promise<boolean | "queue"> => {
    if (!cloud.accountMode) return true;
    if (!stillCurrent()) return false;
    const expected = cloud.accountId ? { accountId: cloud.accountId, bindingVersion: consent.bindingVersion } : null;
    if (!expected || consent.accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) {
      setConsentError(tr("Please sign in to the account for the current project first."));
      toast(tr("Please sign in to the current project's account first"));
      return false;
    }
    try {
      const accepted = await refreshCloudConsent(expected);
      if (cloudConsentState().accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) return false;
      if (!accepted) { setConsentError(null); setConsentOpen(true); }
      return accepted;
    } catch (error) {
      if (!stillCurrent()) return false;
      // Offline, the notice cannot be read: don't show the consent dialog; this message is queued until the network recovers (the notice is checked again before sending after recovery)
      if (opts?.queueable && chat.outbox.transient(error)) return "queue";
      setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable."));
      setConsentOpen(true);
      return false;
    }
  };
  const acceptConsent = () => {
    void acceptCloudConsent().then(
      () => { if (stillCurrent()) { setConsentError(null); setConsentOpen(false); } },
      (error) => { if (stillCurrent()) setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable.")); },
    );
  };

  /* ---------- Session state: chat id, busy or not, permissions ---------- */
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
    // Read silently while offline (e.g. right after queuing one that waits for the network): if the read fails, do not pop up "cannot connect"
    void chat.history.refresh(chat.outbox.offline()).then((ok) => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.accountMode, consent.accepted, chat.conversationId, hasMessages, chat.history.refresh, metadataKey]);
  useEffect(() => { counts.current.set(tabId, chat.messages.length); }, [counts, tabId, chat.messages.length]);
  useEffect(() => () => { counts.current.delete(tabId); }, [counts, tabId]);

  const off = !cloud.enabled || chat.info?.enabled === false;
  const [enabling, setEnabling] = useState(false);

  /* ---------- Input box, quote bar, start page ---------- */
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
  // The input box grows with its content (up to about five lines)
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText, shown]);
  // After selecting an item, click "Quote" (or right-click in preview "Quote to AI"): the same `pc-quote-clip` event, put into the bar rather than the input box
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

  /* ---------- Send and stop ---------- */
  // "Resend" on a "Send failed" bubble (an event emitted by UserBubble in agentParts, carrying the bubble id): only accepted if it is in this page's pending list
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
      if (staged) chat.failStaged(staged, tr("You can't send messages in this chat right now."));
      return false;
    }
    const ok = await chat.send(text, undefined, staged ?? undefined, null, opts);
    return stillCurrent() && ok;
  };
  /** Read-only hook for probes and troubleshooting (same as `window.__pcCloud`): the quotes and body at this page's most recent send click, and the current content of the quote bar */
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
    // Existing chat, permissions not read back yet: do not send yet (the chat may be someone else's private chat); a new chat has no such problem, no need to wait
    if (!metadataReady && hasMessages) { toast(tr("Checking chat permissions, wait a moment before sending")); return; }
    // Send clicked on the start page: only now create the first session, and send this message in it
    start.commit();
    const text = withQuotes(body, quotes);
    const sentQuotes = quotes;
    lastSend.current = { text, quotes: sentQuotes };
    const sentInput = inputText;
    if (cloud.accountMode) {
      // Account mode: on clicking send, the bubble appears in the chat on the spot and the input box is cleared (optimistic display); if it was not sent, the bubble is marked "Not sent" and the original text goes back into the input box
      const staged = chat.stage(text);
      setInputText((prev) => (prev === sentInput ? "" : prev));
      setQuotes((prev) => (prev === sentQuotes ? [] : prev));
      const restore = () => {
        if (!stillCurrent()) return;
        setInputText((prev) => prev || body);
        setQuotes((prev) => (prev.length ? prev : sentQuotes));
      };
      // Offline, or this chat already has messages queued waiting for the network (new ones go behind them, so
      // the order stays intact): no error, just queue, and send automatically when the network is back
      if (staged && (chat.outbox.offline() || chat.outbox.mustQueue()) && chat.outbox.enqueue(text, undefined, staged)) return;
      const admitted = await consentForUse({ queueable: Boolean(staged) });
      if (admitted === "queue" && staged && stillCurrent() && chat.outbox.enqueue(text, undefined, staged)) return;
      if (admitted !== true || !stillCurrent()) {
        if (staged) chat.failStaged(staged, tr("Before using the Cloud Agent, please read and confirm the notice."));
        restore();
        return;
      }
      if (!await sendNow(text, staged, { queueOnNetwork: true })) restore();
      return;
    }
    if (await consentForUse() !== true || !stillCurrent()) return;
    if (view.streaming) { toast(tr("The previous turn is still running, send again after it finishes")); return; }
    if (!await sendNow(text, null)) return;
    if (stillCurrent()) {
      setInputText((prev) => (prev === sentInput ? "" : prev));
      setQuotes((prev) => (prev === sentQuotes ? [] : prev));
    }
  };
  /** When retrying the same operation, reuse the request id (cloud 503s and the like are safe to retry) */
  const reqRef = useRef<{ key: string; id: string } | null>(null);
  const requestId = (key: string) => {
    if (reqRef.current?.key !== key) reqRef.current = { key, id: crypto.randomUUID() };
    return reqRef.current.id;
  };
  const handleStop = async () => {
    if (!cloud.accountMode) { void chat.abort(); return; }
    if (!policy.canStop || !currentRunId) { toast(tr("You can only stop tasks you started")); return; }
    try {
      await chat.abort(currentRunId, requestId(`stop:${currentRunId}`));
      reqRef.current = null;
      void chat.history.refresh();
    } catch (error) {
      if (stillCurrent()) chat.notify(error instanceof Error ? error.message : tr("The stop request failed, you can tap again."));
    }
  };
  const toggleVisibility = async () => {
    if (!policy.canSwitchVisibility || !currentMeta) return;
    const target = currentMeta.visibility === "private" ? "shared" : "private";
    try {
      await chat.switchVisibility(target, requestId(`vis:${chat.conversationId}:${target}`));
      reqRef.current = null;
      await chat.history.refresh();
      if (stillCurrent()) toast(target === "private" ? tr("Switched to private") : tr("Switched to shared"));
    } catch (error) {
      if (stillCurrent()) chat.notify(error instanceof CloudError ? error.message : tr("Couldn't switch for now, you can tap again."));
    }
  };

  const queued = view.queue?.items.filter((i) => i.state === "queued").length ?? 0;
  const stopMode = streaming && inputText.trim().length === 0;
  const visLabel = view.revoked ? tr("Read access revoked") : !metadataReady ? "" : currentMeta ? `${currentMeta.visibility === "private" ? tr("Private chat") : tr("Shared chat")}${creatorReadOnly ? tr(" · creator read-only") : ""}` : tr("New chat · shared by default");

  const banners = (
    <>
      {!cloud.available && <div className="note" data-pcm="agent-note">{tr("The hosting side of this project has no Cloud Agent service.")}</div>}
      {cloud.available && off && <div className="note" data-pcm="agent-note">{cloudErrorText("disabled")}
        {cloud.accountMode && creator && <button type="button" className="btn" disabled={enabling} data-pcm="agent-enable"
          onClick={() => { setEnabling(true); void setAccountAgentEnabled(true).catch((e) => chat.notify(e instanceof Error ? e.message : tr("Unable to enable the Cloud Agent right now."))).finally(() => setEnabling(false)); }}>{tr("Enable Cloud Agent")}</button>}
      </div>}
      {view.connection === "reconnecting" && <div className="note" data-pcm="agent-note">{tr("The connection to the Cloud Agent dropped and is reconnecting. This round is still running in the cloud, and the missed progress will be filled in once reconnected.")}</div>}
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
