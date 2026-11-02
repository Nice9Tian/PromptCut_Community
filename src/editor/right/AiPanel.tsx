import React, { useRef, useState, useEffect, useMemo } from "react";
import "./AiPanel.css";
// Formula stylesheet: LiveMarkdown renders math with KaTeX, and the styles are imported here once
import "katex/dist/katex.min.css";
import { useAiChat } from "../../ai/useAiChat";
import { conversationReport } from "../../ai/debug";
import { collectEnvironment } from "../../ai/envCollect";
import { ReportDialog } from "./ReportDialog";
import { AiSetupDialog } from "./AiSetupDialog";
import { useChatHistory } from "../../ai/useChatHistory";
import { MAIN_TAB, isMainTab } from "../../ai/liveChat";
import * as agentBus from "../../ai/agentBus";
import { setTabBusy, setTabConversation, useAgentTabs } from "../../ai/agentTabs";
import { getChat } from "../../ai/chatStore";
import { useInstallJobs } from "../../ai/sttInstallStore";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { useViewPrefs, setShowThinking } from "./chat/viewPrefs";
import { ChatHeader } from "./chat/ChatHeader";
import { CollapsePanelButton } from "./chat/CollapsePanelButton";
import { MessageList } from "./chat/MessageList";
import { ThinkingStrip } from "./chat/ThinkingStrip";
import { QueueList } from "./chat/QueueList";
import { AgentActivityPanel, useRoundSelection } from "./chat/ActivityPanel";
import { RemoteAgentsStrip } from "./RemoteAgentsStrip";
import { DesktopSessionsStrip } from "./DesktopSessionsStrip";
import { Composer } from "./chat/Composer";
import { memberReadOnlyNow } from "../readOnlyCore";
import { useReadOnly } from "../readOnly";
import { StartHero, useStartPage } from "./chat/StartHero";
import { CloudAiPanel } from "./CloudAiPanel";
import { useCloudAgent, useCloudDigest, useCloudNotices } from "../../ai/extensions";
import { selectCloudTab, useCloudTab } from "../../ai/tabMode";
import { cloudErrorText } from "../../ai/extensions";
import type { RewindHandlers } from "./chat/UserBubble";
import type { ChatAttachment } from "../../ai/types";
import {
  enqueue,
  getQueue,
  clear as clearQueue,
  remove as removeQueued,
  setPaused as setQueuePaused,
  subscribe as subscribeQueue,
  type QueuedItem,
} from "../../ai/chatQueue";
import { rewindAt } from "../../ai/rewind";
import { readQuote } from "../quoteBus";
import {
  kindOfName,
  newAttachmentId,
  pickSrcPath,
  uploadFile,
  waitForJob,
  importByPath,
  acceptAttr,
  type AttachJobView,
} from "../../ai/attachments";
import { tr } from "../../i18n/index.ts";

/**
 * One AI assistant tab.
 *
 * This layer only does composition: the state of the chat (useAiChat), session archive, attachments, drafts,
 * diagnostics and the various switches all lives here,
 * and the visuals are left to the components under chat/. From top to bottom: top bar ChatHeader → login banner →
 * message area MessageList
 * → thinking strip ThinkingStrip → queue QueueList → input area Composer.
 */
export function AiPanel(props: { mcpConnected: boolean; hotkeysOff?: boolean; mock?: boolean; openSetupSignal?: number; tabId?: string; active?: boolean }) {
  // Multi-Agent tabs: each tab is one AiPanel instance, each with its own chat and its own session archive id; tabs
  // not in the foreground are just display:none, and the chat keeps running
  const tabId = props.tabId ?? MAIN_TAB;
  const active = props.active ?? true;
  const convRef = useRef<string | undefined>(undefined);
  // ?aimock=1 is for UI self-tests: it uses the built-in fake stream and needs no model backend installed
  const mock = props.mock ?? (() => {
    try {
      return new URLSearchParams(location.search).has("aimock");
    } catch {
      return false;
    }
  })();
  const { messages, providers, sttInfo, provider, setProvider, streaming, send, runWorkflow, workflowRoles, abort, newChat, error, setMessages, login, loginState, setupJobs, cancelSetup, install, installState, installError, config, saveConfig, clearKey, setupOpen, openSetup, closeSetup, isBusy, pumpQueue, rewindTo } = useAiChat({ mock, tabId, getConversationId: () => convRef.current });
  const history = useChatHistory({ provider, messages, sessionId: undefined, storageKey: tabId === MAIN_TAB ? undefined : `pcChatId:${tabId}` });
  convRef.current = history.conversationId;

  /*
   * The "cloud" connection type (Cloud Agent service contract 9.5, 10.4): this option exists only when the project
   * is in the cloud and the document service reports that this hosted side has a Cloud Agent;
   * local stays the default, "cloud" is never selected automatically, and is only remembered on this tab
   * (`tabMode`). When cloud is chosen, this whole tab is handed to CloudAiPanel (the page connects directly to the
   * cloud node, bypassing the local Agent).
   * `digest` is one info call plus one chat list after the project is opened: the "Cloud" group in the history list
   * and the "cloud chat in progress" hint rely on it, and there is no polling afterwards.
   */
  const cloud = useCloudAgent();
  const cloudTab = useCloudTab(tabId);
  const digest = useCloudDigest(cloud, cloud.available);
  useCloudNotices(cloud, cloud.available);

  // The top bar title is this tab's tab name: after the Agent declares its scope with declare_scope, it is renamed accordingly
  const { tabs } = useAgentTabs();
  const tabTitle = tabs.find((t) => t.id === tabId)?.title ?? tr("AI assistant");

  // The tab needs to know this page's chat ID (the Agent ID shown to the model) and whether it is busy
  // The start page placeholder tab is not yet a real session (isDraft): these two are only remembered after sending turns it into a real tab
  const isDraft = tabs.find((t) => t.id === tabId)?.draft === true;
  useEffect(() => { setTabConversation(tabId, history.conversationId); }, [tabId, history.conversationId, isDraft]);
  useEffect(() => { setTabBusy(tabId, streaming); }, [tabId, streaming, isDraft]);

  // Coming back after a page refresh: chats on non-main tabs are not in .proc, so find them again in the session
  // archive by id
  useEffect(() => {
    if (isMainTab(tabId)) return;
    let alive = true;
    void getChat(history.conversationId).then((chat) => {
      if (alive && chat && chat.messages.length && messages.length === 0) setMessages(chat.messages);
    });
    return () => { alive = false; };
    // Look up only once, at the moment of mounting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  /*
   * Messages that other Agents post with send_message (and tasks that spawn_agent hands to a sub-Agent): the
   * bulletin board is in the editor process
   * (server/agent/agent-board.mjs); when the pushed agent.board says this tab has messages that can be delivered
   * automatically, this tab takes them when idle and
   * sends them out as a user message; when busy it waits until this round finishes (comes again when streaming flips
   * back to false); while running, they are also included in its tool results.
   * Automatic chaining has a hop limit (agentBus.MAX_AUTO_HOPS); messages that hit the cap stay in the mailbox and
   * are brought along the next time the user sends a message.
   */
  useEffect(() => {
    if (streaming) return;
    const convId = history.conversationId;
    let alive = true;
    const deliver = () => {
      // The user's own queue takes priority: if the queue still has items (paused counts too), do not deliver yet; wait
      // until the user's messages are sent or deleted;
      // also do not take them while the driver is not settled (a just-opened sub-Agent tab whose driver list is still
      // being fetched); if taken and then unable to send, they would be lost
      if (!alive || !provider || isBusy() || getQueue(tabId).length > 0) return;
      if (!agentBus.hasAutoDeliverable(convId)) return;
      void agentBus.takeInbox(convId, true).then((msgs) => {
        if (!msgs.length) return;
        if (!alive || isBusy() || getQueue(tabId).length > 0) {
          // During the brief moment after taking them, this tab became busy again (the user just sent a message): put them
          // back on the page side first, and send once this round finishes
          agentBus.stash(convId, msgs);
          return;
        }
        // The model reads the full text of formatInbound; the UI recognizes the inbound field (not drawn as a user
        // bubble, but put into the reply's operation detail preview control)
        void send(agentBus.formatInbound(msgs), undefined, { inbound: msgs.map((x) => ({ from: x.fromLabel ?? x.from ?? tr("unknown"), text: x.text })), hops: Math.max(...msgs.map((m) => m.hops)) });
      });
    };
    deliver();
    const offBus = agentBus.subscribeBus(deliver);
    // When the queue is emptied / editing takes the last item, deliver the accumulated messages again
    const offQueue = subscribeQueue(deliver);
    return () => {
      alive = false;
      offBus();
      offQueue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, history.conversationId, provider]);
  // When a tab is closed, its queue is dropped with it: the queue lives only in memory, not across tabs or refreshes
  useEffect(() => () => clearQueue(tabId), [tabId]);

  const installJobs = useInstallJobs();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** Diagnostic report sub-window: report body + switches */
  const [diagReport, setDiagReport] = useState("");
  const [diagOpen, setDiagOpen] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  /** The draft in the input box. It lives at this layer rather than in Composer: preview right-click quoting of a
   * card and the example sentences in the empty state both need to write into it */
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Attachment placeholder id → original File, needed on retry after failure */
  const retryFilesRef = useRef<Map<string, File>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Start page (this project has no session at all): the message area is replaced by StartHero; clicking a preset
  // puts that sentence into the input box, and only clicking send turns the placeholder tab into the first session
  const start = useStartPage(tabId, inputText, setInputText, () => { requestAnimationFrame(() => textareaRef.current?.focus()); }, messages.length > 0);
  // This project is granted read-only access only (guest): the whole input area is greyed out (Composer's
  // readOnly), and the send path is also guarded in handleSend
  const ro = useReadOnly();

  // Right-clicking a card in the preview, or a clip or an overlay card in a track on the timeline, all dispatch
  // pc-quote-clip (editor/quoteBus.ts), which inserts the quote into the input box
  useEffect(() => {
    const onQuote = (ev: Event) => {
      const q = readQuote(ev);
      if (!q) return;
      const ref = q.token;
      const ta = textareaRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : -1;
      setInputText((prev) => {
        const at = pos >= 0 ? pos : prev.length;
        const before = prev.slice(0, at);
        const after = prev.slice(at);
        // If what precedes is neither whitespace nor the start, add a space so it does not stick to the
        // previous word
        const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const inserted = lead + ref + " ";
        // Place the caret after the re-render, so it lands after the reference
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const caret = before.length + inserted.length;
          el.setSelectionRange(caret, caret);
        });
        return before + inserted + after;
      });
    };
    window.addEventListener("pc-quote-clip", onQuote as EventListener);
    return () => window.removeEventListener("pc-quote-clip", onQuote as EventListener);
  }, []);

  // Concise / detailed, show thinking: shared by all tabs (chat/viewPrefs), not this tab's own state
  const { view, showThinking } = useViewPrefs();
  /** Expanded tool details; the key is `messageId:clipIndex`. Pure UI state, not written into messages */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Spread-out "tile ×N" groups; the key is `messageId:c<chunkIndex>:r<startIndex>` */
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (props.openSetupSignal && props.openSetupSignal > 0) {
      openSetup();
    }
  }, [props.openSetupSignal, openSetup]);

  useEffect(() => {
    const onAiError = (e: Event) => setToast((e as CustomEvent<string>).detail);
    window.addEventListener("ai-chat-error", onAiError);
    return () => window.removeEventListener("ai-chat-error", onAiError);
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const toggleIn = (set: Set<string>, apply: (s: Set<string>) => void) => (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  };
  const toggleTool = toggleIn(expanded, setExpanded);

  /**
   * Small tiles in concise mode: **only one is open** at a time; opening a new one closes the previous.
   *
   * Unlike detailed mode: there each tool block has its own title row and sits at the position of
   * its own segment, so several can be open at once and you can still tell which is which. In
   * concise mode the details are **laid out together below the row of tiles**, so opening two gives
   * two adjacent blobs of JSON, and you cannot tell which tile above each belongs to; the tile row
   * also gets pushed higher and higher, so comparing them means scrolling back and forth.
   *
   * Use a functional update rather than reading the set from the closure like toggleIn: tiles can
   * be clicked in quick succession, and then each click computes from the same stale set, so the
   * later one overwrites the result of the earlier one.
   */
  const toggleChip = (key: string) =>
    setExpanded((prev) => (prev.has(key) ? new Set() : new Set([key])));

  /**
   * A collapsed "tile ×N": click to spread it into single tiles, click the trailing ×N to fold it back.
   * When folding back, also close the expanded details -- otherwise the details stay attached
   * below while the tile they belong to is no longer visible.
   */
  const toggleRun = (key: string) => {
    if (openRuns.has(key)) setExpanded(new Set());
    setOpenRuns((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  // MessageRow is memoized: callbacks go through a ref, so their identity never changes, and
  // expand / collapse use the latest closure
  const handlersRef = useRef({ toggleTool, toggleChip, toggleRun });
  handlersRef.current = { toggleTool, toggleChip, toggleRun };
  const rowHandlers = useMemo(() => ({
    toggleTool: (k: string) => handlersRef.current.toggleTool(k),
    toggleChip: (k: string) => handlersRef.current.toggleChip(k),
    toggleRun: (k: string) => handlersRef.current.toggleRun(k),
  }), []);
  /** Which round "Agent actions" shows: the latest round by default; click a bubble to switch to it */
  const round = useRoundSelection(messages);

  /** Whether the input box has anything (text or attachments): queue "Edit" and putting the original
   * text back on rewind both check it, and if so they ask to confirm replacing it first */
  const hasDraft = () => inputText.trim().length > 0 || attachments.length > 0;

  /** Put the caret back at the end of the input box (after rewind or queue "Edit" puts content back) */
  const focusComposerEnd = () => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  };

  /**
   * Rewind to before a given user message (called after confirmation on UserBubble). Steps:
   *   1-3. useAiChat.rewindTo: if running, stop first and clear the arrangement state; swap the
   *        messages for the truncated copy; clear the session ids of all drivers on this tab;
   *   4. Put that message's original text and attachments back into the input box;
   *   5. Immediately overwrite the whole session archive with the truncated copy (rewinding to the
   *      first message gives an empty list, which the debounced save would not write; see
   *      useChatHistory.overwrite);
   *   6. Leave the entries in the input queue alone. If the rewind interrupted a run, pause the queue
   *      first: the user is rewriting, so don't let queued messages send themselves.
   */
  const doRewind = (userMessageId: string) => {
    const wasRunning = isBusy() || streaming;
    const result = rewindTo(userMessageId);
    if (!result) return;
    if (wasRunning && getQueue(tabId).length > 0) setQueuePaused(tabId, true);
    setInputText(result.restored.text);
    setAttachments(result.restored.attachments);
    history.overwrite(result.kept);
    focusComposerEnd();
  };

  // The rewind entry callback goes through a ref, so its identity never changes: MessageRow is
  // memoized (same reason as rowHandlers above)
  const rewindImplRef = useRef<RewindHandlers | null>(null);
  rewindImplRef.current = {
    countFrom: (id) => rewindAt(messages, id)?.removed.length ?? 0,
    isRunning: () => isBusy() || streaming,
    hasDraft,
    onRewind: doRewind,
  };
  const rewindHandlers = useMemo<RewindHandlers>(() => ({
    countFrom: (id) => rewindImplRef.current?.countFrom(id) ?? 0,
    isRunning: () => rewindImplRef.current?.isRunning() ?? false,
    hasDraft: () => rewindImplRef.current?.hasDraft() ?? false,
    onRewind: (id) => rewindImplRef.current?.onRewind(id),
  }), []);

  /**
   * Collect this chat together with the execution events of every step into one JSON, and show it
   * in a child window. Keys and the model's private thinking are already stripped in
   * conversationReport, so nothing more to handle here.
   *
   * The three exits (copy / save as file / submit) are all in the child window, for the user to
   * pick -- a report easily runs to hundreds of KB. We used to decide for the user whether "this
   * one should be copied or saved", and as a result they could neither see the report nor choose.
   */
  // Collection waits on one local request, and during that time the menu item is still clickable --
  // each click adds another round of collection
  const diagBusy = useRef(false);
  const openDiagnostics = async () => {
    if (messages.length === 0) return setToast(tr("No chat to export yet"));
    if (diagBusy.current) return;
    diagBusy.current = true;
    /*
     * Collect the environment first, then open the window: mode, media library, the backend session
     * file store, Node process state (see ai/envCollect.ts). Without this part, a "product bug"
     * and an "environment problem on this machine" cannot be told apart in the report.
     *
     * Collection waits on one local request, so say so first -- if the service happens to be down it
     * will wait the full 5 seconds here, and a button with no feedback at all makes the user think
     * they missed it and click again.
     */
    setToast(tr("Collecting diagnostics…"));
    let environment: unknown;
    try {
      environment = await collectEnvironment(messages.length);
    } catch (e) {
      // Failing to get the environment must not lose the whole report: the user already has a problem,
      // and the chat itself is the only lead
      environment = { error: e instanceof Error ? e.message : String(e) };
    }
    try {
      setDiagReport(conversationReport(messages, provider, config, environment));
      setDiagOpen(true);
      setToast(null);
    } catch (e) {
      setToast(e instanceof Error ? e.message : tr("Failed to generate the diagnostic report"));
    } finally {
      diagBusy.current = false;
    }
  };
  /** If any events were truncated, say so at the top of the child window, so we don't spend ages
   * investigating from an incomplete report */
  const diagTruncated = messages.some((m) => m.traceTruncated);

  // This tab chose "cloud": the whole tab goes to the cloud chat UI; when a local driver is chosen
  // again, CloudAiPanel clears the flag and hands the choice back here
  if (cloudTab.selected && cloud.available) {
    return (
      <CloudAiPanel
        tabId={tabId}
        active={active}
        hotkeysOff={props.hotkeysOff}
        cloud={cloud}
        initialConversation={cloudTab.conversationId}
        desktop={{ providers, provider, config, onLeave: setProvider }}
      />
    );
  }
  const cloudOff = !cloud.enabled;

  // No driver installed at all: no chat UI, only an entry into AI settings
  if (providers.length > 0 && !providers.some(p => p.available)) {
    return (
      <aside className="panel panel-right ai-panel" data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
        <div className="ai-panel-header">
          <CollapsePanelButton placement="start" />
          <div className="ai-panel-title">{tr("AI assistant")}</div>
          <button className="ai-gear-btn" title={tr("AI settings")} aria-label={tr("AI settings")} onClick={openSetup}><span aria-hidden="true">⚙</span><span>{tr("AI settings")}</span></button>
          <CollapsePanelButton placement="end" />
        </div>
        <div className="ai-empty-state">
          {tr("Claude Code / agy / Codex not found. Install any one of them, then restart the local service")}
          {cloud.available && (
            <div style={{ marginTop: 8 }}>
              <button className="ai-banner-btn" data-pc="ai-use-cloud" disabled={cloudOff} title={cloudOff ? cloudErrorText("disabled") : tr("The project is in the cloud, so you can use the Cloud Agent directly")} onClick={() => selectCloudTab(tabId)}>{tr("Switch to Cloud Agent")}</button>
            </div>
          )}
        </div>
        <AiSetupDialog
          open={setupOpen}
          onClose={() => closeSetup()}
          providers={providers}
          stt={sttInfo || undefined}
          current={provider}
          onChoose={(id) => closeSetup(id)}
          onLogin={login}
          loginState={loginState}
          setupJobs={setupJobs}
          onCancelSetup={cancelSetup}
          onInstall={install}
          installState={installState}
          installError={installError}
          config={config}
          onSaveConfig={saveConfig}
          onClearKey={clearKey}
        />
      </aside>
    );
  }

  const pInfo = providers.find(p => p.id === provider);
  const needsLogin = pInfo && pInfo.auth?.loggedIn === false;
  const st = provider ? loginState[provider] : undefined;

  /** A fake stream goes through no backend, so don't block it on login state; a real backend that
   * is not logged in shows a banner and returns false */
  const passLoginGate = () => {
    if (!mock && needsLogin) {
      setShowLoginPrompt(true);
      return false;
    }
    setShowLoginPrompt(false);
    return true;
  };

  /**
   * Send. text is handed up by the input area (Enter, the "Send" or "Add to queue" button) and is the
   * original text in the input box at that moment.
   *
   * While this tab is running (a normal run, split-work mode, or a queued auto-resume all count) it
   * does not interrupt but goes into the input queue, and useAiChat sends it in order once this
   * round settles; when idle, it sends directly as before.
   */
  const handleSend = (text: string) => {
    // This project only has read-only permission (guest): cannot send messages to the Agent (the input
    // area is already greyed out; this is a fallback for other send paths)
    if (memberReadOnlyNow()) return;
    if (!passLoginGate()) return;
    if (!text.trim() && attachments.length === 0) return;
    // Send clicked on the start page: only now create the first session, and send this message in it
    start.commit();
    // Attachments still importing or that failed to import are left out this time, but sending itself
    // must never be blocked
    const usable = attachments.filter((a) => a.status !== "importing" && a.status !== "error");
    const skipped = attachments.length - usable.length;
    if (skipped > 0) setToast(tr("{0} attachments are still importing or failed to import, and were not included this time", skipped));
    if (isBusy()) {
      // Queuing an empty message is pointless: when there are only attachments not yet imported, leave
      // them in the input box and submit once they are ready
      if (!text.trim() && usable.length === 0) return;
      enqueue(tabId, { text: text.trim(), attachments: usable });
    } else {
      void send(text.trim(), usable);
    }
    setInputText("");
    setAttachments([]);
  };

  /** "■ Stop": stop this round; anything left in the queue is paused, not auto-sent, until the user clicks "Continue" */
  const handleStop = () => {
    if (getQueue(tabId).length > 0) setQueuePaused(tabId, true);
    abort();
  };

  /** Queue "Insert": send this one immediately. If running, reuse the abort at the start of send() to
   * interrupt the current run; the rest of the queue stays queued as usual */
  const insertQueued = (item: QueuedItem) => {
    if (!passLoginGate()) return;
    // Send first, then dequeue (reason: see useAiChat.pumpQueue)
    void send(item.text, item.attachments);
    removeQueued(tabId, item.id);
  };

  /** Queue "Edit": put it back in the input box and remove it from the queue (whether to replace what
   * is already in the input box has been asked by QueueList) */
  const editQueued = (item: QueuedItem) => {
    removeQueued(tabId, item.id);
    setInputText(item.text);
    setAttachments(item.attachments ?? []);
    focusComposerEnd();
  };

  /** Queue "Continue": unpause; if idle, send the head of the queue right away, if still running, wait
   * for this round to settle */
  const resumeQueue = () => {
    if (!passLoginGate()) return;
    setQueuePaused(tabId, false);
    pumpQueue();
  };

  /** The background import that does the real work: fire it off without await, and fill the card
   * back in when it finishes */
  const runImport = (placeholderId: string, file: File, srcPath: string | null) => {
    const cid = history.conversationId;
    (async () => {
      let job: AttachJobView;
      if (srcPath) {
        const init = await importByPath(cid, srcPath, file.name);
        job = init.status === "importing" ? await waitForJob(init.id) : init;
      } else {
        job = await uploadFile(cid, file);
      }
      setAttachments((prev) =>
        prev.map((a) => {
          if (a.id !== placeholderId) return a;
          if (job.status === "ready") {
            // Keep the placeholder card's id, so retry and delete can still match up
            return { ...a, ...job.attachment, id: placeholderId, status: "ready" as const };
          }
          return { ...a, status: "error" as const, error: job.error || job.attachment?.error || tr("Import failed"), jobId: job.id };
        }),
      );
    })().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setAttachments((prev) => prev.map((a) => (a.id === placeholderId ? { ...a, status: "error" as const, error: msg } : a)));
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const placeholderId = newAttachmentId();
      const srcPath = pickSrcPath(file);
      // Insert the placeholder card first; there must be no await before this step, the input area
      // must not stall for even a second
      retryFilesRef.current.set(placeholderId, file);
      setAttachments((prev) => [
        ...prev,
        { id: placeholderId, url: "", name: file.name, kind: kindOfName(file.name), bytes: file.size, srcPath, status: "importing" as const },
      ]);
      runImport(placeholderId, file, srcPath);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  /** New chat: clear this tab's messages and start a new id for the session archive. Entries are in the "✦" menu and at the top of the history drawer */
  const startNewChat = () => {
    newChat();
    history.startNewChat();
  };

  return (
    <aside className="panel panel-right ai-panel" data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
      {/* In SKILL mode, cover the whole block: the project is handed to the agent on the headless
 * instance to edit, and writing from both sides at once would overwrite each other */}
      <ChatHeader
        title={tabTitle}
        mcpConnected={props.mcpConnected}
        showThinking={showThinking}
        onChangeShowThinking={setShowThinking}
        onOpenHistory={() => { setHistoryOpen(true); history.refresh(); if (cloud.available) void digest.refresh(); }}
        onOpenSetup={openSetup}
      />

      {/* The cloud has a chat of this member that is still running (after reopening the app): show a
 * hint, click to attach; do not switch to the cloud automatically */}
      {cloud.available && digest.running.length > 0 && (
        <div className="ai-banner" data-pc="cloud-running-banner">
          <span>{tr("A chat is in progress in the cloud")}</span>
          <button className="ai-banner-btn" onClick={() => selectCloudTab(tabId, digest.running[0])}>{tr("Join and take a look")}</button>
        </div>
      )}

      {needsLogin && (
        <div className="ai-banner">
          <span>{pInfo.auth?.status === 'invalid' ? tr("Codex login has expired, please log in again") : showLoginPrompt ? tr("Log in before sending") : tr("{0} is not logged in", pInfo.label)}</span>
          <button
            className="ai-banner-btn"
            onClick={() => { if (provider) login(provider); setShowLoginPrompt(false); }}
            disabled={st === "waiting"}
          >
            {st === "waiting" ? tr("Login window opened, waiting for you to finish…") : st === "timeout" ? tr("Login timed out, you can try again") : pInfo.auth?.status === 'invalid' ? tr("Log in again") : tr("Log in")}
          </button>
        </div>
      )}
      {/* Login state is unclear (loggedIn is null) but the server gave a repair hint: show it verbatim */}
      {!needsLogin && pInfo?.auth?.loggedIn === null && pInfo.auth.fixHint && (
        <div className="ai-banner">
          {pInfo.auth.fixHint}
          <button className="ai-banner-btn" onClick={openSetup}>{tr("Open AI settings")}</button>
        </div>
      )}

      {/* Where the Agents of other members in a shared project are editing (A3 phase 2, via the document
 * service's presence state) */}
      <RemoteAgentsStrip />
      {/* Sessions of the desktop app (SKILL, plan A4): one group per session, vendor + ongoing operation +
 * progress report */}
      <DesktopSessionsStrip />
      {start.draft ? (
        <StartHero animated={start.animated} onPickPreset={start.pickPreset} />
      ) : (
        <MessageList
          messages={messages}
          view={view}
          showThinking={showThinking}
          installJobs={installJobs}
          expanded={expanded}
          openRuns={openRuns}
          rowHandlers={rowHandlers}
          onPickExample={setInputText}
          rewind={rewindHandlers}
          selectedRound={round.id}
          onSelectRound={round.select}
        />
      )}

      {/* "Agent actions": the operations and reports of this chat, shown per round (replaces the
 * "Agent action log" listed per project channel, user decision, 2026-10-20); the step that wrote
 * to the project can be undone in the detailed preview */}
      <AgentActivityPanel messages={messages} selectedId={round.id} onSelect={round.select} view={view}
        installJobs={installJobs} expanded={expanded} on={rowHandlers} />
      <ThinkingStrip messages={messages} streaming={streaming} />
      <QueueList
        tabId={tabId}
        running={streaming}
        onInsert={insertQueued}
        onEdit={editQueued}
        onResume={resumeQueue}
        hasDraft={hasDraft}
      />

      {toast && <div className="ai-toast">{toast}</div>}
      {error && <div className="ai-toast" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error}</div>}

      <Composer
        text={inputText}
        onTextChange={setInputText}
        textareaRef={textareaRef}
        attachments={attachments}
        uploading={uploading}
        onPickFiles={() => fileInputRef.current?.click()}
        onRetryAttachment={(id, srcPath) => {
          const f = retryFilesRef.current.get(id);
          if (!f) return;
          setAttachments((prev) => prev.map((x) => (x.id === id ? { ...x, status: "importing" as const, error: undefined } : x)));
          runImport(id, f, srcPath);
        }}
        onRemoveAttachment={removeAttachment}
        onSubmit={handleSend}
        onStop={handleStop}
        streaming={streaming}
        hotkeysOff={props.hotkeysOff}
        active={active}
        provider={provider}
        providers={providers}
        onSetProvider={setProvider}
        config={config}
        tabId={tabId}
        guide={start.guide}
        readOnly={ro.locked}
        readOnlyReason={ro.why}
        menu={{
          workflowRoles,
          onRunWorkflow: () => void runWorkflow(),
          canDiagnose: messages.length > 0,
          onOpenDiagnostics: () => void openDiagnostics(),
          onNewChat: startNewChat,
        }}
        cloud={cloud.available ? {
          show: true,
          selected: false,
          disabled: cloudOff,
          disabledReason: cloudErrorText("disabled"),
          onSelect: () => selectCloudTab(tabId),
          onLeave: () => {},
          toolbar: null,
          attachReason: "",
        } : undefined}
      />
      <input
        type="file"
        ref={fileInputRef}
        accept={acceptAttr()}
        multiple
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <AiSetupDialog
        open={setupOpen}
        onClose={() => closeSetup()}
        providers={providers}
        stt={sttInfo || undefined}
        current={provider}
        onChoose={(id) => closeSetup(id)}
        onLogin={login}
        loginState={loginState}
        setupJobs={setupJobs}
        onCancelSetup={cancelSetup}
        onInstall={install}
        installState={installState}
        installError={installError}
        config={config}
        onSaveConfig={saveConfig}
        onClearKey={clearKey}
      />
      <ReportDialog
        open={diagOpen}
        title={tr("Chat diagnostic report")}
        label={tr("Chat diagnostics")}
        hint={diagTruncated ? tr("Includes the visible chat and every execution event; oversized events were truncated") : tr("Includes the visible chat and every execution event; excludes keys and the model's private reasoning")}
        text={diagReport}
        onClose={() => setDiagOpen(false)}
      />
      <ChatHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={history.history}
        loading={history.loading}
        query={history.query}
        onQueryChange={history.setQuery}
        currentId={history.conversationId}
        onPick={async (id) => {
          const loaded = await history.openChat(id);
          if (loaded) setMessages(loaded);
          setHistoryOpen(false);
        }}
        onDelete={(id) => history.removeChat(id)}
        onNewChat={() => { startNewChat(); setHistoryOpen(false); }}
        cloud={cloud.available ? { items: digest.items, loading: digest.loading, onPick: (id) => { selectCloudTab(tabId, id); setHistoryOpen(false); } } : undefined}
      />
    </aside>
  );
}
