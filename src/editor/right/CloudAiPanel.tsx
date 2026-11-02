import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./AiPanel.css";
import "./CloudAiPanel.css";
// Formula stylesheet: LiveMarkdown renders math with KaTeX
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
// The code version is fetched through the cross-cutting seam in boot.ts (registerBuildInfo/getBuildInfo
// built by workstream E). This panel is a public file and must not import cloud/online/buildInfo.ts
// directly; in the community edition codeVersion defaults to null.
import { getBuildInfo } from "../../online/boot";
import { acceptCloudConsent, cloudConsentState, grantCloudConsent, onCloudConsentRequired, refreshCloudConsent, subscribeCloudConsent, type CloudConsentPermit } from "../../ai/extensions";
import { CloudAgentConsentDialog } from "./CloudAgentConsentDialog";
import { CloudDeleteChatDialog, type CloudDeleteAsk } from "./CloudDeleteChatDialog";
import { LIBRARY_KINDS, putInLibrary, type LibraryOutcome } from "./cloudAttachLibrary";
import { CLOUD_CHAT_TEXT } from "../../ai/chatTexts";
import { createPoller, type Poller } from "../../ai/poll";
import type { CloudChatItem } from "../../ai/chatTypes";
import { readQuote } from "../quoteBus";
import { tr } from "../../i18n/index.ts";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

type CloudControlRequest =
  | { kind: "visibility"; target: "shared" | "private"; conversationId: string; requestId: string; scope: CloudControlScopeToken }
  | { kind: "stop"; runId: string; conversationId: string; requestId: string; scope: CloudControlScopeToken };

/** When embedded from the desktop app's AI panel, the few things the local side must provide (the online page provides none) */
export interface CloudDesktopSide {
  providers: ProviderInfo[];
  provider: AiProvider | null;
  config: PublicAiConfig | null;
  /** A local driver was picked on the cloud tab: go back to local mode */
  onLeave: (p: AiProvider) => void;
}

/**
 * One AI assistant tab for the "Cloud" connection type (contract 9.5). In the online browser at wide
 * widths it is the whole right-side AI panel; in the desktop app, once a tab picks "Cloud" this takes
 * over that tab (`AiPanel` hands it over at that point), and picking a local driver again gives it
 * back to `AiPanel`.
 *
 * The only difference from the local Agent is "where this turn runs": the message goes to the cloud
 * node's Agent service (202, this turn is independent of this page's connection), the page follows
 * progress through an event stream and reconnects automatically to catch up when it drops; if the
 * page is closed or the app is quit, the cloud turn keeps running and is picked up again on reopen.
 * The chat UI is rebuilt entirely from events; the page stores no cloud chat records.
 *
 * This touches no `/api/*` here: model, chat and tool execution are all in the cloud, and the page
 * only calls `/agent/v1/*`.
 */
export function CloudAiPanel(props: {
  tabId?: string;
  active?: boolean;
  hotkeysOff?: boolean;
  cloud: CloudAgentState;
  desktop?: CloudDesktopSide;
  /** A cloud chat opened from the history list */
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
      error => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable.")); });
    return () => { dead = true; };
    // A new account/project binding gets a fresh server result; rejecting does not trigger a loop.
  }, [cloud.accountMode, cloud.available, cloud.projectId, cloud.accountId, consent.accountId, consent.bindingVersion]);
  /**
   * Before use, read the consent notice fresh from the account service. When allowed, returns `{ permit }`:
   * in account mode it is a one-time permit issued by this fresh read, handed to `chat.send` of the same
   * send, which checks on the spot that it is still valid and does not read a second time (one send checks
   * the notice only once); when not allowed, returns null.
   */
  const consentForUse = async (opts?: { queueable?: boolean }): Promise<{ permit: CloudConsentPermit | null } | { queue: true } | null> => {
    if (!cloud.accountMode) return { permit: null };
    if (!stillCurrent()) return null;
    const expected = cloud.accountId ? { accountId: cloud.accountId, bindingVersion: consent.bindingVersion } : null;
    if (!expected || consent.accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) {
      setConsentError(tr("Please sign in to the account for the current project first."));
      return null;
    }
    try {
      const { accepted, permit } = await grantCloudConsent(expected);
      if (cloudConsentState().accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) return null;
      // Only show the consent dialog when consent is truly missing; if consent was given but no permit was obtained (permit is null), send as usual, chat.send reads once more itself before sending
      if (!accepted) { setConsentError(null); setConsentOpen(true); return null; }
      return { permit };
    } catch (error) {
      if (!stillCurrent()) return null;
      // Offline, the notice cannot be read: don't show the consent dialog; this message is queued until the network recovers (the notice is checked again before sending after recovery)
      if (opts?.queueable && chat.outbox.transient(error)) return { queue: true };
      setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable."));
      setConsentOpen(true);
      return null;
    }
  };
  const acceptConsent = () => { void acceptCloudConsent().then(() => { if (stillCurrent()) { setConsentError(null); setConsentOpen(false); } },
    error => { if (stillCurrent()) setConsentError(error instanceof Error ? error.message : tr("The cloud account is temporarily unavailable.")); }); };
  // Offline pending send (user decision, 2026-10-22): messages sent while offline are queued and sent automatically when the network recovers; queued ones with attachments are likewise put into the media library first, before actually being sent
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
  // A message sent on this tab was rejected for "consent not given" (the read before sending, or the server replying consent-required when receiving the message): show the consent dialog
  useEffect(() => {
    if (!cloud.accountMode) return;
    return onCloudConsentRequired((binding, origin) => {
      if (origin !== tabId || binding.accountId !== cloud.accountId || binding.bindingVersion !== consent.bindingVersion) return;
      setConsentError(null);
      setConsentOpen(true);
    });
  }, [cloud.accountMode, cloud.accountId, consent.bindingVersion, tabId]);
  const { tabs } = useAgentTabs();
  const tabTitle = desktop ? (tabs.find((t) => t.id === tabId)?.title ?? tr("AI assistant")) : tr("Cloud Agent");
  // The "Chat ID" on the tab is used for the local Agent's multi-Agent communication; after this tab picks a local driver again in the desktop app it is still needed, so the cloud chat id is not written into it
  // The start-page placeholder tab is not yet a real session (isDraft): it is only recorded after Send turns it into a real tab
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
  // This project's chat list (shared by several tabs, read as soon as the project is entered): once read, we can tell whose this chat is and whether it can be sent to: no need to wait for a round trip on every chat switch or tab open.
  // The list only decides UI switches; sending messages, changing permissions and stopping are checked one by one on the server.
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
    // Use a read from within the last two seconds directly (common when switching tabs or chats), without waiting for a round trip
    void chat.history.refresh(false, 2000).then(ok => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, chat.history.refresh, metadataKey]);

  // A newly created cloud chat only appears in the server list after its first message lands; when refreshing session metadata, confirm its real owner and permissions.
  const hasMessages = chat.messages.length > 0;
  useEffect(() => {
    if (!cloud.accountMode || !hasMessages) return;
    let live = true;
    // While offline (e.g. right after queuing a message to wait for the network), read silently: if it can't be read, don't show "Can't connect", and sending a message reports no error (user decision, 2026-10-22)
    void chat.history.refresh(chat.outbox.offline()).then(ok => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.accountMode, consent.accepted, chat.conversationId, hasMessages, chat.history.refresh, metadataKey]);

  // The creator turned the switch off: notified by the member list (`cloud.enabled`) or reported by info
  const off = !cloud.enabled || chat.info?.enabled === false;
  const offText = cloudErrorText("disabled");

  /* ---------- Draft, queue, send ---------- */
  const [inputText, setInputText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Start page (this project has no session at all): the message area is replaced by StartHero; clicking a preset puts that sentence into the input box, and only clicking Send turns the placeholder tab into the first session (in the cloud, a new cloud chat)
  const start = useStartPage(tabId, inputText, setInputText, () => { requestAnimationFrame(() => textareaRef.current?.focus()); }, chat.messages.length > 0);
  // This project is granted read-only access only (guest): the whole input area is greyed out (Composer's
  // readOnly), and the send path is also guarded in handleSend
  const ro = useReadOnly();
  // A guest can only open one chat per project (user decision, 2026-10-23): they already have one, so the "New chat" entry is grayed out, with the explanation on hover and in the hint bar;
  // what is shown right now is still a new chat that was never sent (on return it can't remember the last one, and it isn't in the list), so the input area is grayed out too, pointing to "Chat history" to continue that one.
  // What really blocks is the server (`guest-chat-limit`); this just keeps them from writing a message in vain
  const guestChatFull = cloud.accountMode && chat.history.guest && chat.history.atLimit;
  const guestNoNewChat = guestChatFull && !chat.history.items.some((x) => x.id === chat.conversationId);
  /* Attachments: pick files → upload one by one to this cloud chat's working directory (shown as uploading) → attach the uploaded ones when sending. On failure the reason is shown, with click-to-retry and remove */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Attachment placeholder id → original file (for retry on failure) and in-progress upload (cancelled on remove) */
  const retryFilesRef = useRef<Map<string, File>>(new Map());
  /** Result of putting attachments into the media library, keyed by the attachment card's id: resending the same message doesn't put them in again and the request content stays the same (the document service checks content by request number) */
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
  // After switching chats (new chat, picked another from history, or auto-attaching to a running one on entry): attachments only exist in the working directory of the chat they were uploaded to, and don't follow
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

  // "Quote to AI" from right-clicking a card in the preview, or a clip or overlay card on the timeline: the same event as the local AI panel (editor/quoteBus.ts)
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

  // "Resend" on a "Failed to send" bubble (event emitted by UserBubble, carries the bubble number):
  // only accepted if it is in this page's pending-send list
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

  /**
   * Also counts as busy for the short moment right after sending, before the server's user event has
   * come back (avoids two quick sends hitting "a turn is still in progress in this chat")
   */
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
    if (off || !stillCurrent() || !controlPolicy.canSend || view.revoked) { if (staged) chat.failStaged(staged, tr("You can't send messages in this chat right now.")); return false; }
    if (!cloud.accountMode) markSent();
    // Account mode: image, video and audio attachments go into the media library first, and the Agent is
    // told which entry it is (user decision, 2026-10-18)
    const prepared = cloud.accountMode && files?.length ? await withLibrary(files) : files;
    if (!stillCurrent()) return false;
    const ok = await chat.send(text, prepared, staged ?? undefined, consentPermit, opts);
    if (!stillCurrent()) return false;
    if (!ok) { echoWait.current = false; bump((n) => n + 1); }
    return ok;
  };

  const handleSend = async (text: string) => {
    // This project only grants read-only access (guest): messages to the Cloud Agent are not allowed. The
    // input area is already greyed out (Composer); this is a safety net for the other send paths (queue, resend)
    if (memberReadOnlyNow()) return;
    if (creatorReadOnly || view.revoked || (!text.trim() && attachments.length === 0)) return;
    if (off) return;
    // Send clicked on the start page: only now create the first session, and send this message in it
    start.commit();
    if (cloud.accountMode && text.trim()) {
      // Account mode: clicking send immediately shows a bubble in the chat and clears the input box (optimistic
      // display, user request 2026-10-19); the acknowledgement, adding to the media library and sending all happen later.
      // If it was not sent, the bubble is marked "Not sent" with the reason, and the original text goes back into the
      // input box (only if the box is empty at that moment). Until the cloud accepts it the bubble only says
      // "Sending…" and is not shown as sent
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
      // Offline, or this chat already has messages queued waiting for the network (new ones go behind them, so
      // the order stays intact): no error, just queue, and send automatically when the network is back
      if (staged && (chat.outbox.offline() || chat.outbox.mustQueue()) && chat.outbox.enqueue(text.trim(), usable, staged)) {
        if (skipped > 0) chat.notify(tr("{0} attachments are still uploading or failed to upload and were not included this time.", skipped));
        return;
      }
      const admission = await consentForUse({ queueable: Boolean(staged) });
      if (admission && "queue" in admission) {
        if (staged && stillCurrent() && chat.outbox.enqueue(text.trim(), usable, staged)) return;
        if (staged) chat.failStaged(staged, tr("Read and confirm the notice before using Cloud Agent."));
        restore();
        return;
      }
      if (!admission || !stillCurrent()) {
        if (staged) chat.failStaged(staged, tr("Read and confirm the notice before using Cloud Agent."));
        restore();
        return;
      }
      if (skipped > 0) chat.notify(tr("{0} attachments are still uploading or failed to upload and were not included this time.", skipped));
      if (!await sendNow(text.trim(), usable, staged, admission.permit, { queueOnNetwork: true })) restore();
      return;
    }
    const admission = await consentForUse();
    if (!admission || "queue" in admission || !stillCurrent()) return;
    // Attachments that are still uploading or failed to upload are left out this time, but the send itself
    // is not blocked
    const { usable, skipped } = pickSendable(attachments, chat.conversationId);
    if (!text.trim()) {
      // The server does not accept empty messages: with attachments only, keep them in the input box and wait
      // for the user to write a sentence
      chat.notify(skipped > 0 && usable.length === 0 ? tr("{0} attachments are still uploading or failed to upload. Wait for them to finish or retry before sending.", skipped) : CLOUD_ATTACH_NEED_TEXT);
      return;
    }
    if (skipped > 0) chat.notify(tr("{0} attachments are still uploading or failed to upload and were not included this time.", skipped));
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

  // A turn ended: if idle and not paused, send the head of the queue
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
    setControlNote(request.kind === "visibility" ? tr("Updating chat permissions…") : tr("Submitting stop request to the cloud…"));
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
        ? request.target === "private" ? tr("Switched to private.") : tr("Switched to shared.")
        : tr("The cloud confirmed the stop request. Syncing chat state."));
    } catch (error) {
      if (!isCurrentControl(request)) return;
      // Re-read visibility; on 503/fence pending, keep the original request ID so the user can safely retry
      // the same operation.
      const refreshed = await chat.history.refresh();
      if (!isCurrentControl(request)) return;
      if (refreshed) setMetadataReadyKey(metadataKey);
      const pending = error instanceof CloudError && (error.status >= 500 || error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable");
      if (pending) {
        controlPendingRef.current = request;
        setControlPending(request);
        setControlNote(error instanceof CloudError && error.code === "agent-fence-pending"
          ? tr("New access is blocked, and the related services are still waiting to be confirmed closed. Clicking retry reuses the original request.")
          : tr("The cloud has not yet confirmed this operation. State was re-read; clicking retry reuses the original request."));
      } else {
        controlPendingRef.current = null;
        setControlPending(null);
        setControlNote(error instanceof Error ? error.message : tr("The cloud control request failed. Please re-read the chat state."));
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
      // Stopping has to wait for the event where the server finishes wrapping up
      for (let i = 0; i < 40 && stillCurrent() && chat.store.get().some((m) => m.pending); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (!stillCurrent()) return;
    // It may have waited for the stop to wrap up in between, so the permit has most likely expired; when it
    // has, chat.send will read it again as usual
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

  /**
   * The actual upload: fired off without await, and when it finishes it fills the result back into that
   * attachment card (the placeholder id is kept so retry and remove still match up)
   */
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
        ...(!admitted ? { error: tr("Please acknowledge the Cloud Agent notice first, then retry the upload.") } : {}) }]);
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

  /* ---------- Expanded state of message rows (same as AiPanel) ---------- */
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
  /** Which round "Agent actions" shows: the latest round by default; click a bubble to switch to it */
  const round = useRoundSelection(chat.messages);

  /* ---------- Diagnostic report (user decision, 2026-10-07: works as usual in the cloud) ----------
   * Generated in the page from the messages, session state and client info rebuilt from this cloud chat's
   * events; it requests no `/api/*`, and contains no tickets, delegation or model keys.
   * "Save as file" on the online page is a browser download, the desktop app keeps writing to local disk;
   * submitting goes to the same report-collection address as on this machine (greyed out with an
   * explanation if it is not configured). */
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

  /* ---------- Delete chat (user decision, 2026-10-12: whoever opened a chat deletes their own, the creator
   * deletes anyone's; confirm first; if a task is running, stop it before deleting) ---------- */
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
      // The task has not fully stopped (503 agent-fence-pending) or the cloud has not confirmed yet: the chat
      // still exists, retry with the same request ID
      // 5xx errors (including purge-failed, where the deletion went through but the cloud cleanup failed) are also
      // retryable, but the wording must fit: only say "The task has not fully stopped" when the fence is unfinished
      const retryable = error instanceof CloudError && (error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable" || error.status >= 500);
      const fencePending = error instanceof CloudError && (error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable");
      setDeleteAsk({ ...ask, stage: retryable ? "pending" : "error",
        text: error instanceof CloudError ? (fencePending ? CLOUD_CHAT_TEXT.deletePending : error.message) : cloudErrorText("network") });
      void chat.history.refresh();
    }
  };

  // If the page was closed halfway through a deletion (task not fully stopped): when this account opens the
  // page again, quietly carry on, without waiting for them to click "Continue deleting" (user decision,
  // 2026-10-13: no cancelling a deletion).
  // The document service also finishes it on its own as soon as the task settles (completePendingDeletions in
  // conversation-authority.mjs); this just lets this page see the result sooner.
  // Rules (review 6): the same chat keeps the same request ID, only one in flight at a time, failures back off
  // (starting at 10 seconds, doubling, capped at 5 minutes), stop if login is invalid, do nothing while the page
  // is not visible;
  // when the same account has several tabs open, skip this attempt if another tab did it within the last
  // 20 seconds (a timestamp is kept in localStorage).
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
        try { const at = JSON.parse(localStorage.getItem(stampKey) ?? "null"); if (at && at.tab !== resumeTabRef.current && Date.now() - at.t < 20_000) return; } catch { /* If it cannot be read, proceed anyway */ }
        try { localStorage.setItem(stampKey, JSON.stringify({ tab: resumeTabRef.current, t: Date.now() })); } catch { /* If it cannot be written, proceed anyway */ }
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

  /* ---------- History list ---------- */
  const openHistory = () => { setHistoryOpen(true); void chat.history.refresh(); };
  const historyItems = useMemo(() => {
    // The current chat has just sent its first message and the server list has not refreshed yet: list it first
    const hit = chat.history.items.some((x) => x.id === chat.conversationId);
    // Only count messages the cloud already has: the local bubbles placed the moment send was clicked (still
    // sending, or not sent, sendState) do not count, and a chat that was never sent must not be listed in history first
    const landed = chat.messages.filter((m) => !m.sendState || m.id.startsWith("cq-"));
    if (hit || landed.length === 0) return chat.history.items;
    const title = landed.find((m) => m.role === "user")?.text.slice(0, 40) || tr("Cloud chat");
    return [{ id: chat.conversationId, title, updatedAt: Date.now(), state: streaming ? "running" as const : "idle" as const, lastSeq: view.lastSeq }, ...chat.history.items];
  }, [chat.history.items, chat.conversationId, chat.messages, streaming, view.lastSeq]);

  const connLabel = view.connection === "live" ? tr("Connected to the cloud") : view.connection === "connecting" ? tr("Connecting to the cloud…") : view.connection === "reconnecting" ? tr("Connection lost, reconnecting…") : tr("Not connected to the cloud");

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
        settingsDisabled={tr("The Cloud Agent's model is configured by the host, so there are no AI settings to change here")}
      />

      {!cloud.available && <div className="ai-banner" data-pc="cloud-unavailable">{tr("The hosting side of this project has no Cloud Agent service.")}</div>}
      {cloud.available && off && <div className="ai-banner" data-pc="cloud-off">{offText}</div>}
      {cloud.accountMode && cloud.available && off && creator && <button type="button" data-pc="cloud-agent-enable" disabled={enabling}
        onClick={() => { setEnabling(true); void setAccountAgentEnabled(true).catch(error => chat.notify(error instanceof Error ? error.message : tr("Unable to enable the Cloud Agent right now."))).finally(() => setEnabling(false)); }}>{tr("Enable Cloud Agent")}</button>}
      {view.connection === "reconnecting" && (
        <div className="ai-banner pc-cloud-reconnect" data-pc="cloud-reconnecting">
          {tr("The connection to the Cloud Agent dropped and is reconnecting. This round is still running in the cloud, and the missed progress will be filled in once reconnected.")}
        </div>
      )}

      {cloud.accountMode && (
        <div className="pc-cloud-controls" data-pc="cloud-conversation-controls" data-visibility={view.revoked ? "revoked" : (currentMeta?.visibility ?? "unknown")}>
          {view.revoked ? (
            <span className="pc-cloud-access-label is-revoked" data-pc="cloud-visibility-label">
              {tr("Read access revoked")}
            </span>
          ) : !metadataReady ? <span data-pc="cloud-permission-loading">{tr("Reading chat permissions…")}</span> : currentMeta ? <>
            <span className="pc-cloud-access-label" data-pc="cloud-visibility-label">
              {currentMeta.visibility === "private" ? tr("Private chat") : tr("Shared chat")}{creatorReadOnly ? tr(" · Project creator is read-only") : ""}
            </span>
            {canSwitchVisibility && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-visibility-toggle"
              disabled={visibleControlPending?.kind === "stop"}
              onClick={handleVisibilityToggle}>
              {visibleControlPending?.kind === "visibility"
                ? tr("Retry setting to {0}", visibleControlPending.target === "private" ? tr("private") : tr("shared"))
                : currentMeta.visibility === "private" ? tr("Make shared") : tr("Make private")}
            </button>}
          </> : <span className="pc-cloud-access-label" data-pc="cloud-new-conversation">{tr("New cloud chat · shared by default")}</span>}
          {controlNote && <span className="pc-cloud-control-note" data-pc="cloud-control-status" role="status">{controlNote}</span>}
          {visibleControlPending?.kind === "stop" && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-stop-retry"
            onClick={() => visibleControlPending && void applyCloudControl(visibleControlPending)}>{tr("Retry stop request")}</button>}
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

      {/* "Agent actions": the actions and reports of this chat shown per turn (replaces the "Agent action log"
   listed per project channel, user decision, 2026-10-20) */}
      <AgentActivityPanel messages={chat.messages} selectedId={round.id} onSelect={round.select} view={viewMode}
        installJobs={installJobs} expanded={expanded} on={rowHandlers} />
      <ThinkingStrip messages={chat.messages} streaming={streaming} />
      {cloud.accountMode ? <CloudQueueList queue={view.queue} messages={chat.messages} senders={view.senders} executorMounted={chat.info?.executorMounted === true} /> :
        <QueueList tabId={qKey} running={view.streaming} onInsert={insertQueued} onEdit={editQueued} onResume={resumeQueue} hasDraft={hasDraft} />}

      {cloud.accountMode && chat.messages.some(m => m.role === 'assistant' && m.pending && (m.progress?.waitingJobs || m.progress?.phase === 'waiting_jobs')) &&
        (!view.queue?.items?.filter(item => item.state === 'queued').length) && (
        <div className="ai-banner pc-cloud-waiting-jobs" data-pc="cloud-waiting-jobs">
          {tr("The background job started by the previous message (transcription, shot detection, etc.) is still running. Your message will be handled once it finishes.")}
        </div>
      )}

      {cloud.accountMode && chat.messages.some(m => m.role === 'assistant' && m.pending && ((m.progress as Record<string, any>)?.renderQueuePosition || m.progress?.phase === 'render_queued')) &&
        (!view.queue?.items?.filter(item => item.state === 'queued').length) && (
        <div className="ai-banner pc-cloud-render-queued" data-pc="cloud-render-queued">
          {tr("The cloud render is busy with another project. You are No. {0} in the queue and it will continue when your turn comes.", (chat.messages.find(m => m.role === 'assistant' && m.pending && ((m.progress as Record<string, any>)?.renderQueuePosition || m.progress?.phase === 'render_queued'))?.progress as Record<string, any>)?.renderQueuePosition ?? 1)}
        </div>
      )}

      {cloud.accountMode && chat.history.atLimit && !chat.history.items.some((x) => x.id === chat.conversationId) && (
        <div className="ai-banner" data-pc={chat.history.guest ? "cloud-guest-chat-limit" : "cloud-limit-note"} role="status">
          {chat.history.guest ? CLOUD_CHAT_TEXT.guestLimit : CLOUD_CHAT_TEXT.limitComposer}
        </div>
      )}
      {chat.notice && (
        <div className="ai-toast" data-pc="cloud-notice" role="alert" onClick={chat.clearNotice} title={tr("Click to dismiss")}>{chat.notice}</div>
      )}
      <div className="pc-cloud-note" data-pc="cloud-note">{cloud.accountMode && chat.info?.executorMounted !== true ? tr("Messages are queued persistently while waiting for the executor service; reopen to pick up where you left off.") : tr("Runs in the cloud and continues after you close it; reopen to pick up where you left off")}</div>

      {creatorReadOnly ? <div className="pc-cloud-readonly" data-pc="cloud-readonly-note">
        {tr("The project creator can view this private chat but cannot send messages.")}
        {canStopCurrentRun && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-stop-readonly" onClick={handleStop}>{tr("Stop current turn")}</button>}
      </div> : !metadataReady ? <div className="pc-cloud-readonly" data-pc="cloud-permission-wait">{tr("Checking chat permissions. You can't send messages until this is confirmed.")}</div> : <Composer
        text={inputText}
        onTextChange={setInputText}
        textareaRef={textareaRef}
        attachments={attachments}
        uploading={false}
        disabled={Boolean(view.revoked) || guestNoNewChat}
        disabledReason={view.revoked ? tr("The current account can no longer read this chat. Please select a chat you have access to.") : guestNoNewChat ? CLOUD_CHAT_TEXT.guestLimit : undefined}
        readOnly={ro.locked}
        readOnlyReason={ro.why}
        onPickFiles={() => fileInputRef.current?.click()}
        onRetryAttachment={(id) => retryAttachment(id)}
        onRemoveAttachment={removeAttachment}
        onSubmit={handleSend}
        onStop={handleStop}
        canStop={cloud.accountMode ? canStopCurrentRun : undefined}
        stopDisabledReason={cloud.accountMode && !canStopCurrentRun ? tr("You can only stop tasks you started") : undefined}
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
        title={tr("Cloud chat diagnostic report")}
        label={tr("Cloud chat diagnostics")}
        hint={tr("Includes the process, error causes and client info of this cloud chat; does not include tickets, delegations, model keys or any credentials")}
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
