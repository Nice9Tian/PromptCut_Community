import { recordTrace } from './debug';
import { refreshProviders, reportAuthFailure, subscribeProviders } from './providerState';
import { appendTextPart, applyDeltas, isDeltaEvent } from './streamBatch';
import { useState, useEffect, useRef, useCallback } from "react";
import type { AiProvider, ChatMessage, ChatAttachment, MessagePart, MessageRuntime, ProviderInfo, RunEvent, SttInfo, LoginState, PublicAiConfig, AiConfigPatch, CliSetupJob, KeyKind } from "./types";
import { parseSseChunks } from "./sse";
import { readChoice, compatToSend, normalizeModel, modelsFor, pairModelEffort, sanitizeEffort } from "./modelOptions";
import { getScript } from "./script";
import { useChatMessages, getChatStore, isMainTab, MAIN_TAB } from "./liveChat";
import { WORKFLOW_ROLES } from "./roles";
import { getState } from "../store/project";
import { getTabCreativity, getTabProvider } from "./agentTabs";
import { projectCreativity } from "../kernel/creativity.mjs";
import { mediaCardUrl } from "./mediaRef";
import { buildHandoff } from "./handoff";
import { getQueueState, remove as removeQueued } from "./chatQueue";
import { rewindAt, type RewindResult } from "./rewind";
import { tr } from "../i18n/index.ts";

/** On rollback, the session id of every driver on this tab has to be cleared; the list is here */
const ALL_PROVIDERS: AiProvider[] = ["claude", "agy", "codex", "api"];

/**
 * Arranges the media in the media library into the shape of an attachment manifest, attached to
 * every send (the server lists it as a separate "media library" section).
 *
 * url gives a /@media/<file name> that a card can reference directly, and **no disk path**: it used
 * to give path, and the model, having no tool that can read the disk, was nevertheless led by that
 * path on every round to Read and curl (see mediaRef.ts).
 * Entries that have not finished uploading, so that cardUrl cannot be derived, are not listed for
 * now, to avoid giving an address that cannot be used.
 */
function mediaAsAttachments(): ChatAttachment[] {
  try {
    return getState().project.media
      .map((m) => ({ m, cardUrl: mediaCardUrl(m) }))
      .filter(({ cardUrl }) => cardUrl)
      .map(({ m, cardUrl }) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        url: cardUrl,
        library: true,
        status: "ready" as const,
        durationSec: m.duration,
      })) as ChatAttachment[];
  } catch {
    return [];
  }
}

/** Streaming text/thinking deltas are applied to state at most this often. */
const DELTA_FLUSH_MS = 80;

/** Fill in the result for the most recent tool part with the same name that has no result yet */
function completeToolPart(
  parts: MessagePart[] | undefined,
  ev: { name: string; ok: boolean; summary?: string; files?: string[]; callId?: string; durationMs?: number },
): MessagePart[] {
  const next = parts ? [...parts] : [];
  for (let i = next.length - 1; i >= 0; i--) {
    const p = next[i];
    if (p.kind === "tool" && (ev.callId ? p.callId === ev.callId : p.name === ev.name) && p.ok === undefined) {
      next[i] = { ...p, ok: ev.ok, summary: ev.summary, files: ev.files, durationMs: ev.durationMs };
      return next;
    }
  }
  next.push({ kind: "tool", name: ev.name, ok: ev.ok, summary: ev.summary, files: ev.files });
  return next;
}

/**
 * The first-run settings dialog pops up only once per page load: it used to be popped by the "main
 * tab"; after the tab manifest was split per project and the first session was no longer the fixed
 * "main", whichever tab gets here first pops it.
 */
let setupGateClaimed = false;
function claimSetupGate(): boolean {
  if (setupGateClaimed) return false;
  setupGateClaimed = true;
  return true;
}

export function useAiChat(opts?: { mock?: boolean; tabId?: string; getConversationId?: () => string | undefined }) {
  // The chat belongs to the project (it is saved and loaded with .proc and switched with the project),
  // so it lives in a store outside the component.
  // Multi-Agent tabs: one store per tab; only the main tab's (MAIN_TAB) is saved and loaded with
  // .proc
  const tabId = opts?.tabId ?? MAIN_TAB;
  const store = getChatStore(tabId);
  const setMessages = store.set;
  const messages = useChatMessages(store);
  // The CLI driver's session id is also kept separately per tab: two tabs sharing one sessionId would
  // mean two Agents carrying on the same conversation
  const sessKey = (p: string) => (isMainTab(tabId) ? `aiSession:${p}` : `aiSession:${p}:${tabId}`);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sttInfo, setSttInfo] = useState<SttInfo | null>(null);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [sessionIds, setSessionIds] = useState<Partial<Record<AiProvider, string>>>({});
  /**
   * How many automatic resumes are left. Every new message the user sends resets it to 1:
   * "at most one automatic resume per round of user input", leaving no opening for an infinite loop.
   */
  const autoContinueLeftRef = useRef(1);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setupOpen, setSetupOpen] = useState(false);
  const [loginState, setLoginState] = useState<Partial<Record<AiProvider, LoginState>>>({});
  const [config, setConfig] = useState<PublicAiConfig | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  /*
   * The lifecycle of a round, for the input queue (see chatQueue.ts, pumpQueue below):
   * - sendSeqRef: incremented on every abort() (including the one at the start of send). If the
   *   sequence number has not changed when a round settles, it was neither stopped by the user nor
   *   displaced by a new send;
   * - busyRef: true from the start of send until this round settles. Unlike streaming, it is read
   *   synchronously;
   * - autoContinueTimerRef: the automatic resume after an error that has been scheduled but not yet
   *   sent;
   * - workflowRef: one-click effects is running serially, and the queue waits for it to finish
   *   before sending.
   */
  const sendSeqRef = useRef(0);
  const busyRef = useRef(false);
  const autoContinueTimerRef = useRef<number | null>(null);
  const workflowRef = useRef(false);
  const unmountedRef = useRef(false);
  /**
   * The send from the latest render. Sending the queue head after a round settles, and automatic
   * resuming, both use it: the provider / config in an old closure may already have changed
   */
  const sendRef = useRef<(text: string, attachments?: ChatAttachment[], sendOpts?: { auto?: boolean; hops?: number }) => Promise<boolean>>(async () => false);
  // When this tab is closed (a multi-Agent tab being closed), cut off the request still running: as
  // soon as the connection drops the server aborts that round
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      if (autoContinueTimerRef.current !== null) window.clearTimeout(autoContinueTimerRef.current);
      autoContinueTimerRef.current = null;
      abortControllerRef.current?.abort();
    };
  }, []);
  const currentRunId = useRef<string | null>(null);
  const setupGateRef = useRef(false);
  const [setupJobs, setSetupJobs] = useState<CliSetupJob[]>([]);
  /** CLI install: idle | installing | ok | timeout | failed */
  const [installState, setInstallState] = useState<Partial<Record<AiProvider, "idle" | "installing" | "ok" | "timeout" | "failed">>>({});
  const [installError, setInstallError] = useState<Partial<Record<AiProvider, string>>>({});


  useEffect(() => {
    if (opts?.mock) {
      setProviders([
        { id: "claude", label: "Claude Code", available: true, version: "2.1.221", auth: { loggedIn: false, loginCommand: ["claude", "auth", "login"] } },
        { id: "codex", label: "Codex", available: true, version: "0.136.0", auth: { loggedIn: null, detail: "unknown variant ultra, expected one of none|minimal|low|medium|high|xhigh", fixHint: tr("The model_reasoning_effort value on line 5 of the codex config file ~/.codex/config.toml is not recognized by this version of codex. Change it to high or xhigh and try again"), loginCommand: ["codex", "login"] } },
        { id: "agy", label: "Antigravity", available: true, version: "1.1.27", auth: { loggedIn: true } },
        { id: "api", label: tr("Direct API"), available: false, note: tr("API key not set yet"), auth: { loggedIn: false, detail: tr("API key not set yet") } }
      ]);
      setConfig({ version: 1, defaultProvider: null, toolProtocol: true, api: { vendor: "anthropic", baseUrl: "", model: "gpt-4o|gpt-4o-mini", maxTokens: 4096, apiKey: { set: false, last4: "" }, source: "" }, keys: { custom: { set: false, last4: "" }, router: { set: false, last4: "" } }, cliModels: { claude: "opus|sonnet|haiku", codex: "gpt-5.6-terra|gpt-5.6-sol", agy: "gemini-3.8-flash-high|gemini-3.8-flash-medium|gemini-3.8-flash-low|gemini-3.1-pro-high|gemini-3.1-pro-low|claude-sonnet-4-6" } });
      setProvider("claude");
      // ?nosetup=1 is for automation scripts: do not pop up the first-run settings dialog
      if (localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup") && claimSetupGate()) {
        setSetupOpen(true);
      }
      return;
    }

    fetch("/api/ai/config")
      .then((res) => res.json())
      // The bridge uniformly uses the { ok, config } envelope (consistent with other interfaces); a bare
      // publicConfig is accepted too
      .then((data) => setConfig(data?.config ?? data))
      .catch(() => {});

    refreshProviders()
      .then((data: any) => {
        let list: ProviderInfo[] = [];
        let stt: SttInfo | null = null;
        if (Array.isArray(data)) {
          list = data;
        } else if (data && typeof data === "object") {
          list = data.providers || [];
          stt = data.stt || null;
        }
        setProviders(list);
        setSttInfo(stt);

        const stored = localStorage.getItem("aiProvider") as AiProvider;
        // A subagent started by spawn_agent keeps the parent chat's driver (A3): it is fixed when this tab
        // is started and does not follow the global selection
        const preset = getTabProvider(tabId) as AiProvider | null;
        if (preset) {
          setProvider(preset);
        } else if (stored && list.some((p) => p.id === stored && p.available)) {
          setProvider(stored);
        } else {
          const firstAvailable = list.find((p) => p.available);
          if (firstAvailable) {
            setProvider(firstAvailable.id);
            localStorage.setItem("aiProvider", firstAvailable.id);
          }
        }
      })
      .catch((e: unknown) => {
        if (e instanceof Error) {
          setError(tr("Failed to get AI providers: ") + e.message);
        } else {
          setError(tr("Failed to get AI providers"));
        }
      });
  }, [opts?.mock]);

  useEffect(() => {
    if (opts?.mock) return;
    return subscribeProviders(setProviders);
  }, [opts?.mock]);

  useEffect(() => {
    if (providers.length > 0 && !setupGateRef.current && !opts?.mock) {
      setupGateRef.current = true;
      // ?nosetup=1 is for automation scripts: do not pop up the first-run settings dialog
      if (localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup") && claimSetupGate()) {
        setSetupOpen(true);
      }
    }
  }, [providers, opts?.mock]);

  // A single non-overlapping poll follows all providers and survives dialog reopen.
  useEffect(() => {
    if (opts?.mock) return;
    let stopped = false;
    let timer: number;
    let lastFinished = '';
    const poll = async () => {
      try {
        const res = await fetch('/api/ai/setup', { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(tr("Unable to get install and login progress"));
        const data = await res.json();
        if (stopped) return;
        const jobs: CliSetupJob[] = data.jobs || [];
        setSetupJobs(jobs);
        for (const job of jobs) {
          if (job.kind === 'install') {
            setInstallState(prev => ({ ...prev, [job.provider]: job.state === 'running' ? 'installing' : job.state === 'succeeded' ? 'ok' : 'failed' }));
            setInstallError(prev => ({ ...prev, [job.provider]: job.state === 'failed' ? job.message : '' }));
          } else {
            setLoginState(prev => ({ ...prev, [job.provider]: job.state === 'running' ? 'waiting' : job.state === 'succeeded' ? 'ok' : 'failed' }));
          }
        }
        const finished = jobs.filter(j => j.state !== 'running').map(j => j.id + j.state).join(',');
        if (finished !== lastFinished) {
          await refreshProviders(true);
          lastFinished = finished;
        }
      } catch (e) {
        if (!stopped) setSetupJobs(prev => prev.map(j => j.state === 'running' ? { ...j, message: tr("Connection interrupted, re-fetching progress…") } : j));
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [opts?.mock]);

  const startSetup = useCallback(async (id: AiProvider, kind: 'install' | 'login', deviceAuth = false) => {
    if (kind === 'install') {
      setInstallState(prev => ({ ...prev, [id]: 'installing' }));
      setInstallError(prev => ({ ...prev, [id]: '' }));
    } else setLoginState(prev => ({ ...prev, [id]: 'waiting' }));
    try {
      const res = await fetch('/api/ai/' + kind, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: id, deviceAuth }), signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || tr("Request failed"));
      setSetupJobs(prev => [...prev.filter(j => j.provider !== id), data.job]);
    } catch (e) {
      const message = e instanceof Error ? e.message : tr("Request failed");
      if (kind === 'install') {
        setInstallState(prev => ({ ...prev, [id]: 'failed' }));
        setInstallError(prev => ({ ...prev, [id]: message }));
      } else {
        setLoginState(prev => ({ ...prev, [id]: 'failed' }));
        setSetupJobs(prev => [...prev.filter(j => j.provider !== id), { id: 'request-failed', provider: id, kind, state: 'failed', message, logs: [] }]);
        setError(message);
      }
    }
  }, []);
  const install = useCallback((id: AiProvider) => startSetup(id, 'install'), [startSetup]);
  const login = useCallback(async (id: AiProvider, deviceAuth = false) => {
    if (opts?.mock) {
      setLoginState(prev => ({ ...prev, [id]: 'ok' }));
      setProviders(prev => prev.map(p => p.id === id ? { ...p, auth: { ...p.auth, loggedIn: true } } : p));
      return;
    }
    await startSetup(id, 'login', deviceAuth);
  }, [opts?.mock, startSetup]);

  const cancelSetup = useCallback(async (id: AiProvider) => {
    try {
      const res = await fetch('/api/ai/setup', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(tr("Cancel failed, please retry"));
    } catch (e) { setError(e instanceof Error ? e.message : tr("Cancel failed")); }
  }, []);

  const saveConfig = useCallback(async (patch: AiConfigPatch) => {
    if (opts?.mock) {
      setConfig(prev => {
        if (!prev) return prev;
        const newApi = { ...prev.api, ...patch.api } as any;
        if (patch.api?.apiKey !== undefined) {
          if (typeof patch.api.apiKey === "string" && patch.api.apiKey.length > 0) {
            newApi.apiKey = { set: true, last4: patch.api.apiKey.slice(-4) };
          } else if (patch.api.apiKey === null) {
            newApi.apiKey = { set: false, last4: "" };
          }
        }
        // The mock stream must also merge the way the real interface does: whichever field is missed, the
        // corresponding switch in the UI will bounce back to its old value after saving, which looks like a
        // bug but is really the mock stream not keeping up (toolProtocol fell into this once)
        return {
          ...prev,
          defaultProvider: patch.defaultProvider !== undefined ? patch.defaultProvider : prev.defaultProvider,
          toolProtocol: patch.toolProtocol !== undefined ? patch.toolProtocol : prev.toolProtocol,
          cliModels: patch.cliModels ? { ...prev.cliModels, ...patch.cliModels } : prev.cliModels,
          api: newApi
        };
      });
      return;
    }

    try {
      const res = await fetch("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("save config failed");
      const data = await res.json();
      setConfig(data?.config ?? data);
    } catch (e) {
      setError(tr("Failed to save settings"));
      throw e;
    }
  }, [opts?.mock]);

  /** "Clear key": delete the key file of that source and get the latest config back */
  const clearKey = useCallback(async (kind: KeyKind) => {
    if (opts?.mock) {
      setConfig(prev => {
        if (!prev) return prev;
        const keys = { ...prev.keys, [kind]: { set: false, last4: "" } };
        const active = prev.api.source === kind;
        return { ...prev, keys, api: active ? { ...prev.api, apiKey: { set: false, last4: "" }, source: "" } : prev.api };
      });
      return;
    }
    const res = await fetch("/api/ai/config/clear-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || tr("Failed to clear keys"));
    setConfig(data.config);
  }, [opts?.mock]);

  const openSetup = useCallback(() => setSetupOpen(true), []);

  const closeSetup = useCallback((chosen?: AiProvider) => {
    setSetupOpen(false);
    localStorage.setItem("aiSetupDone", "1");
    if (chosen) {
      localStorage.setItem("aiProvider", chosen);
      setProvider(chosen);
      saveConfig({ defaultProvider: chosen }).catch(() => {});
    }
  }, [saveConfig]);

  useEffect(() => {
    if (!provider) return;
    // Switching model leaves the chat alone: the chat belongs to this project, and carrying on with a
    // different model is reasonable
    const sess = localStorage.getItem(sessKey(provider));
    if (sess) {
      setSessionIds((prev) => ({ ...prev, [provider]: sess }));
    }
  }, [provider]);

  const handleProviderChange = (newP: AiProvider) => {
    setProvider(newP);
    localStorage.setItem("aiProvider", newP);
  };

  const newChat = () => {
    if (!provider) return;
    localStorage.removeItem(sessKey(provider));
    setMessages([]);
    setSessionIds((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  };

  const abort = useCallback(() => {
    // First make the running round "expire": when it settles later its sequence number will not match,
    // so it will not go on to send the queue head
    sendSeqRef.current += 1;
    busyRef.current = false;
    // Also cancel any automatic resume that has not been sent: when the user stops, it stays stopped,
    // and a newly sent message should not be interrupted by a resume either
    if (autoContinueTimerRef.current !== null) {
      window.clearTimeout(autoContinueTimerRef.current);
      autoContinueTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (currentRunId.current && !opts?.mock) {
      fetch("/api/ai/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: currentRunId.current }),
      }).catch(() => {});
      currentRunId.current = null;
    }
    setMessages(prev => prev.map(m => m.pending ? { ...m, pending: false, outcome: 'aborted', finishedAt: Date.now() } : m));
    setStreaming(false);
  }, [opts?.mock]);

  /**
   * Whether this tab counts as running right now: a send is in progress, or an automatic resume is
   * scheduled. The Composer uses it to decide whether what it submits is sent directly or queued
   */
  const isBusy = useCallback(() => busyRef.current || autoContinueTimerRef.current !== null, []);

  /**
   * Sends the head of the input queue when idle. Call sites: a round really settles (finishRun), the
   * user clicks "Continue", one-click effects finishes running.
   * It does not send while paused, while an automatic resume is still scheduled, while one-click
   * effects has not finished, or while currently busy, so two messages are never sent at the same time.
   *
   * Send first, then dequeue: the synchronous part of send has already set busyRef, so the
   * subscriptions triggered by dequeuing (the automatic delivery of agentBus in AiPanel) see "busy"
   * and do not slip another one in during this brief gap.
   */
  const pumpQueue = useCallback((): boolean => {
    if (unmountedRef.current || busyRef.current || autoContinueTimerRef.current !== null || workflowRef.current) return false;
    const q = getQueueState(tabId);
    if (q.paused || q.items.length === 0) return false;
    const head = q.items[0];
    void sendRef.current(head.text, head.attachments);
    removeQueued(tabId, head.id);
    return true;
  }, [tabId]);

  /**
   * Called when a round really settles (deltas flushed, outcome written into the message, and not
   * stopped / displaced)
   */
  const finishRun = useCallback(() => {
    busyRef.current = false;
    pumpQueue();
  }, [pumpQueue]);

  /**
   * Rolls back to before a given user message. The entry point is in UserBubble, and AiPanel calls it
   * after confirmation; returns null when the id is wrong.
   *   1. If running, stop first, and clear the arrangement state of split-work mode as well
   *      (a new generation, so updates arriving late from the old arrangement are no longer written back);
   *   2. This tab's messages are replaced with the truncated copy;
   *   3. The session ids of **all drivers** on this tab are cleared: the next send starts the session
   *      from scratch on the backend, and the rounds that remain are carried over by the "prior
   *      context" (buildHandoff).
   * Putting back into the input box and overwriting the whole archive are done next by AiPanel; the
   * input queue is left alone.
   */
  const rewindTo = (userMessageId: string): RewindResult | null => {
    if (!rewindAt(store.get(), userMessageId)) return null;
    if (busyRef.current || autoContinueTimerRef.current !== null || abortControllerRef.current) abort();
    // abort() marks the still-running message as aborted, so recompute from the copy after it has been marked
    const result = rewindAt(store.get(), userMessageId);
    if (!result) return null;
    setMessages(result.kept);
    for (const p of ALL_PROVIDERS) {
      try {
        localStorage.removeItem(sessKey(p));
      } catch {
        /* If storage is unavailable, clear only state */
      }
    }
    setSessionIds({});
    return result;
  };

  // The third parameter is called sendOpts rather than opts: this function body reads the **outer
  // hook's** opts everywhere (opts.mock, opts.getConversationId), and a same-name parameter would
  // shadow it completely, silently: it only blows up when the types do not match, and otherwise it
  // is an undefined read at runtime.
  //
  // Returns whether this round settled normally (not stopped, not displaced by a new send); one-click
  // effects uses it to decide whether to run the next role.
  // sendOpts.inbound: this message is actually one sent by another Agent (automatic delivery by
  // AiPanel), attached unchanged to the user message so the UI recognizes it
  // sendOpts.hops: which level of automatic delivery this is (messages from other Agents, A3), from
  // which the server's bulletin board caps the chain
  const send = async (text: string, attachments?: ChatAttachment[], sendOpts?: { auto?: boolean; inbound?: ChatMessage["inbound"]; hops?: number }): Promise<boolean> => {
    if (!provider) return false;
    // Only what the user sends themselves resets the allowance; an automatic resume does not, otherwise
    // "resume → error again → resume again" could spin forever
    if (!sendOpts?.auto) autoContinueLeftRef.current = 1;

    abort();
    // The sequence number of this send: check it after every await returns; a mismatch means it was
    // stopped or displaced midway
    const seq = sendSeqRef.current;
    busyRef.current = true;

    // The user's message enters the message stream **at the very instant it is sent**
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      text,
      attachments,
      ...(sendOpts?.inbound?.length ? { inbound: sendOpts.inbound } : {}),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Fix "what this one runs with" at the moment of sending, and make **what is sent and what is
    // recorded the same copy**. If they were read separately, a user switching model during streaming
    // would make the record disagree with what actually ran.
    const choice = readChoice(provider);
    /*
     * The model name goes through the list once more here. The panel has long done this
     * (normalizeModel), but that only decides what the dropdown shows; sending a request has always used
     * the raw value in localStorage. So a name that is no longer in the list (settings were changed, or a
     * character was mistyped by hand in the first place) shows "Default" in the UI, while the request
     * still carries it. The CLI gets a model name that does not exist and exits on the spot, and the
     * user sees no message at all.
     * What is displayed and what actually runs must be the same value.
     */
    choice.model = normalizeModel(choice.model, modelsFor(provider, config));
    /*
     * agy's model name and thinking tier must be paired (gemini-3.8-flash-low with --effort high is
     * refused on the spot), and which tiers each model has differs per model. The panel has two boxes,
     * "base name + tier", and before sending they are assembled here into the pair agy accepts; other
     * drivers are returned as is.
     */
    {
      const pair = pairModelEffort(provider, choice.model, choice.effort, config);
      choice.model = pair.model;
      choice.effort = pair.effort;
    }
    /*
     * The tier also needs a fallback check against the list: the same reasoning as normalizeModel above,
     * and the same pit was stepped in.
     *
     * The tier is stored in localStorage. After the list changed (0ae554b removed codex's `minimal`
     * because upstream does not recognize it at all and selecting it always gives a 400), that value is
     * still in old users' browsers. ModelBar only downgrades it to "Default" for **display**, while the
     * request path reads the raw localStorage value, so the UI says "Default" and the request still
     * carries minimal, and gets the same 400. What is displayed and what actually runs must be the same
     * value.
     */
    choice.effort = sanitizeEffort(provider, choice.model, choice.effort, config);
    // Parameter compatibility mode: a locked driver / model ignores the local preference and goes by
    // the policy's verdict; an adjustable one hands the preference to the server
    choice.schemaCompat = compatToSend(provider, choice.model, config?.api?.vendor, choice.schemaCompat);
    const runtime: MessageRuntime = { provider, ...choice, toolProtocol: !!config?.toolProtocol };

    const asstMsgId = (Date.now() + 1).toString();
    const asstMsg: ChatMessage = {
      id: asstMsgId,
      role: "assistant",
      text: "",
      parts: [],
      tools: [],
      statuses: [],
      pending: true,
      startedAt: Date.now(),
      runtime,
      trace: [],
    };

    // The user message is already in above; only the assistant's one is appended here
    setMessages((prev) => [...prev, asstMsg]);
    setStreaming(true);
    setError(null);

    if (opts?.mock) {
      let i = 0;
      const msg = tr("This is the built-in fake stream reply. I will call a tool to see how it works.");
      const timer = setInterval(() => {
        // Stopped or displaced by a new send: the mock stream stops too; do not keep writing into the aborted
        // message, and do not turn streaming off afterwards
        if (seq !== sendSeqRef.current) {
          clearInterval(timer);
          return;
        }
        if (i < msg.length) {
          // Each frame writes "the whole text so far", not an incremental concatenation:
          // the first tick may beat the assistant message actually being enqueued, and that incremental update
          // would be silently dropped, shifting every later character by one (one missing at the start, an
          // extra undefined at the end).
          i++;
          const soFar = msg.slice(0, i);
          setMessages(prev => prev.map(m => m.id === asstMsgId
            ? { ...m, text: soFar, parts: [{ kind: "text", text: soFar }] }
            : m));
        } else {
          clearInterval(timer);
          setMessages(prev => prev.map(m => m.id === asstMsgId ? {
            ...m,
            tools: [{ name: "get_editor_state", input: {} }],
            parts: [...(m.parts || []), { kind: "tool", name: "get_editor_state", input: {} }],
          } : m));
          setTimeout(() => {
            if (seq !== sendSeqRef.current) return;
            setMessages(prev => prev.map(m => {
              if (m.id !== asstMsgId) return m;
              const tools = [...(m.tools || [])];
              if (tools.length > 0) {
                tools[0].ok = true;
                tools[0].summary = tr("Fetched successfully");
              }
              const parts = completeToolPart(m.parts, { name: "get_editor_state", ok: true, summary: tr("Fetched successfully") });
              return { ...m, tools, parts };
            }));
            // Say one more sentence after the tool finishes: in detailed mode the true order "text → tool → text"
            // should appear.
            // This passage also serves as a rendering sample: tables, inline formulas and standalone-line
            // formulas are all in it
            const tail = [
              tr("The tool returned, and the timeline is empty now. Suggested arrangement:"),
              "",
              tr("| Card | Start | End |"),
              "| --- | ---: | ---: |",
              tr("| Quote card | 3.0 | 8.0 |"),
              tr("| Number counter | 8.0 | 10.5 |"),
              "",
              tr("Duration of each card \\(d = t_1 - t_0\\), total exported frames:"),
              "",
              "$$N = \\lceil (t_1 - t_0) \\times fps \\rceil$$",
            ].join("\n");
            setTimeout(() => {
              if (seq !== sendSeqRef.current) return;
              setMessages(prev => prev.map(m => m.id === asstMsgId
                ? { ...m, text: m.text + "\n" + tail, parts: appendTextPart(m.parts, "\n" + tail), pending: false, outcome: "completed" }
                : m));
              setStreaming(false);
              // This round of the mock stream settles: send the queue head here, the same as for a real stream
              finishRun();
            }, 600);
          }, 1000);
        }
      }, 50);
      return true;
    }

    const ac = new AbortController();
    abortControllerRef.current = ac;
    /** Whether this round settled normally (see the part in finally that sends the queue head) */
    let settled = false;

    /*
     * Deltas arrive many times per second. Applying each as its own state update
     * re-rendered the panel and re-parsed the reply's Markdown per token: a
     * synthetic 1500-delta reply kept the editor's main thread in long tasks for
     * 58% of the stream. Queue deltas in arrival order and apply them together at
     * most every DELTA_FLUSH_MS; every other event, the end of the stream and
     * errors flush the queue first, so ordering is unchanged.
     */
    let queuedDeltas: RunEvent[] = [];
    let deltaTimer: number | null = null;
    const flushDeltas = () => {
      if (deltaTimer !== null) { window.clearTimeout(deltaTimer); deltaTimer = null; }
      if (!queuedDeltas.length) return;
      const batch = queuedDeltas;
      queuedDeltas = [];
      setMessages(prev => prev.map(m => m.id === asstMsgId ? applyDeltas(m, batch, recordTrace) : m));
    };

    try {
      /*
       * The session id goes by **localStorage**, not the state in the component.
       *
       * When the project is switched, projectAi.applyProjectAi clears all `aiSession:*` (see there for
       * the reason), but it cannot clear this hook's state: if the state were read, the first message after
       * switching projects would still carry the previous project's session id, and the server would
       * again read that history back in full.
       * The state is kept only for display; what decides "which history to continue" must be the same
       * source of truth.
       */
      const sessionId = (() => {
        try { return localStorage.getItem(sessKey(provider)) || undefined; }
        catch { return sessionIds[provider]; }
      })();
      // Multi-Agent: this tab's chat ID is carried with the request, and the server hands it to the MCP
      // process so that a tool call knows who sent it; the activity of other Agents (scope changes,
      // messages to it) is prepended to the prompt by the server's bulletin board (A3). It goes to the
      // model only, not into the user message shown on the screen
      const agentId = opts?.getConversationId?.();
      // The model was switched: condense the rounds this provider has not seen into the "prior context"
      // and send it along (see handoff.ts for the reason).
      // The question and answer just appended do not count as history
      const handoff = buildHandoff(
        store.get().filter((m) => m.id !== userMsg.id && m.id !== asstMsgId),
        provider,
        !!sessionId,
      );
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          prompt: [handoff, text].filter(Boolean).join("\n\n"),
          conversationId: agentId,
          ...(sendOpts?.hops ? { hops: sendOpts.hops } : {}),
          sessionId,
          // Model / reasoning effort / fast mode: already read at the moment of sending above (choice), so a
          // change the user makes in the panel takes effect on the very next message. Which provider supports
          // what is translated on the runner side; here we only pass the selection along.
          ...choice,
          // What is in the media library is listed into the attachment manifest as well: the model does not
          // have to spend a round on list_media to learn which media it has, and a request like "add
          // captions to every video" then also has a definite target.
          attachments: [...(attachments ?? []), ...mediaAsAttachments()],
          // The script is sent with every round and spliced into the system prompt by the server: over many
          // rounds the model drifts most easily, and saying it once in the first message cannot keep it on track.
          script: getScript(),
          // Creativity level: the one set separately for this tab (null = follow the project) and the project's
          // default level at this moment. The server's gate uses them to judge calls that exceed the level; the
          // project default goes by the project the server reads, and the one reported here is used only when
          // it cannot be read (currentProjectCreativity in server/vite-plugin-ai.ts)
          creativity: getTabCreativity(tabId),
          projectCreativity: projectCreativity(getState().project),
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunks(buffer, chunk);
        buffer = rest;

        for (const ev of events as RunEvent[]) {
          // Text and thinking deltas are queued and merged (thinking goes only into parts, not into m.text;
          // see applyDeltas)
          if (isDeltaEvent(ev)) {
            queuedDeltas.push(ev);
            if (deltaTimer === null) deltaTimer = window.setTimeout(flushDeltas, DELTA_FLUSH_MS);
            continue;
          }
          flushDeltas();
          setMessages(prev => prev.map(m => m.id === asstMsgId ? recordTrace(m, ev) : m));
          if (ev.type === "run" && ev.runId) {
            currentRunId.current = ev.runId;
          } else if (ev.type === "session" && ev.sessionId) {
            setSessionIds((prev) => ({ ...prev, [provider]: ev.sessionId! }));
            localStorage.setItem(sessKey(provider), ev.sessionId!);
          } else if (ev.type === "tool_call" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                tools.push({ name: ev.name!, input: ev.input, callId: ev.callId, expanded: false });
                const parts: MessagePart[] = [
                  ...(m.parts || []),
                  { kind: "tool", name: ev.name!, input: ev.input, callId: ev.callId },
                ];
                return { ...m, tools, parts };
              })
            );
          } else if (ev.type === "tool_result" && ev.name) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const tools = m.tools ? [...m.tools] : [];
                for (let i = tools.length - 1; i >= 0; i--) {
                  if ((ev.callId ? tools[i].callId === ev.callId : tools[i].name === ev.name) && tools[i].ok === undefined) {
                    tools[i].ok = ev.ok;
                    tools[i].summary = ev.summary;
                    tools[i].files = ev.files;
                    tools[i].durationMs = ev.durationMs;
                    break;
                  }
                }
                const parts = completeToolPart(m.parts, {
                  name: ev.name!,
                  ok: ev.ok,
                  summary: ev.summary,
                  files: ev.files,
                  callId: ev.callId,
                  durationMs: ev.durationMs,
                });
                return { ...m, tools, parts };
              })
            );
          } else if (ev.type === "progress") {
            setMessages(prev => prev.map(m => m.id === asstMsgId ? { ...m, progress: { ...m.progress, ...ev } } : m));
          } else if (ev.type === "status" && ev.text) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== asstMsgId) return m;
                const statuses = m.statuses ? [...m.statuses] : [];
                statuses.push(ev.text!);
                const parts: MessagePart[] = [...(m.parts || []), { kind: "status", text: ev.text! }];
                return { ...m, statuses, parts };
              })
            );
          } else if (ev.type === "error" && ev.message) {
            reportAuthFailure(ev);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, error: ev.message, pending: false, finishedAt: Date.now(), outcome: "error" } : m
              )
            );
            /*
             * A resumable interruption: automatically say one more sentence, so the user does not have to click
             * retry.
             *
             * We do not need to carry the context: the CLI routes all pass `--conversation <id>`, and agy brings
             * the whole conversation back as is; all that needs filling in is "why did it stop just now", and
             * that sentence is assembled by the driver and placed in retryPrompt (carrying the original
             * rejection text directly), and sent out unchanged here, so the model does not have to ask itself.
             *
             * **Resume only once**. Which errors are worth resuming is decided by the driver (wrong keys, wrong
             * model names and exhausted quotas do not carry this flag), but the decision cannot always be right;
             * if a resume hits the same error again, resuming further is an infinite loop burning the user's
             * quota. If one attempt does not work, stop there and leave the error for the user to see: they
             * know more than we do.
             * The allowance resets when the user sends a new message (see the start of send).
             */
            if (!ev.authReason && ev.retryable && ev.retryPrompt && autoContinueLeftRef.current > 0) {
              autoContinueLeftRef.current -= 1;
              const prompt = ev.retryPrompt;
              // Record this scheduled resume: until it is sent this tab still counts as busy, and the input queue
              // must not jump ahead of it (see pumpQueue); if the user clicks stop before then, abort() cancels it
              autoContinueTimerRef.current = window.setTimeout(() => {
                autoContinueTimerRef.current = null;
                void sendRef.current(prompt, undefined, { auto: true });
              }, 0);
            }
          } else if (ev.type === "done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstMsgId ? { ...m, pending: false, finishedAt: Date.now(), outcome: ev.outcome || m.outcome || "completed", usage: ev.usage } : m
              )
            );
          }
        }
      }

      flushDeltas();
      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstMsgId ? { ...m, pending: false } : m
        )
      );

    } catch (e: unknown) {
      // Keep whatever text already arrived before the stream stopped.
      flushDeltas();
      if (e instanceof Error && e.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstMsgId
              ? { ...m, error: tr("An error occurred: ") + e.message, pending: false, finishedAt: Date.now(), outcome: "error" }
              : m
          )
        );
      }
    } finally {
      if (abortControllerRef.current === ac) {
        abortControllerRef.current = null;
        currentRunId.current = null;
        setStreaming(false);
      }
      /*
       * The automatic sending of the input queue hangs here: by the time finally is reached, the deltas have
       * been flushed and the outcome has been written into the message, and only then has the round really
       * settled.
       * Sequence number unchanged = not stopped by the user (the outcome of a stopped one is aborted) and
       * not displaced by a new send; a round cut off by the connection being unmounted (closing the tab)
       * does not count either. If an automatic resume after an error is still scheduled, pumpQueue lets
       * the resume go first.
       */
      if (seq === sendSeqRef.current && !ac.signal.aborted) {
        settled = true;
        finishRun();
      }
    }
    return settled;
  };
  sendRef.current = send;

  /**
   * One-click effects: runs each role in src/ai/roles/ for one round, in order.
   *
   * Serial rather than spliced into one long prompt: the editing director has to see all the media
   * before it can arrange the video, and the effects assistant needs a transcript before it can add
   * captions and motion graphics; combined in one round, the model would neglect one for the other.
   * Every round is a complete send, so once the user stops it, the later roles are not run.
   *
   * While it runs, the input queue waits (pumpQueue checks workflowRef): otherwise the queue head would
   * be sent as soon as the previous role settles, only to be interrupted when the next role starts. It
   * is sent after the whole series finishes.
   */
  const runWorkflow = useCallback(async () => {
    workflowRef.current = true;
    try {
      for (const role of WORKFLOW_ROLES) {
        // If it did not settle normally (the user pressed stop, or another send displaced it), do not go on
        // to the next role
        if (!(await sendRef.current(role.prompt))) break;
      }
    } finally {
      workflowRef.current = false;
    }
    pumpQueue();
  }, [pumpQueue]);

  return {
    messages,
    providers,
    sttInfo,
    provider,
    setProvider: handleProviderChange,
    sessionIds,
    runWorkflow,
    workflowRoles: WORKFLOW_ROLES,
    streaming,
    send,
    abort,
    /**
     * Whether it counts as running right now (read synchronously, including a scheduled automatic
     * resume); the Composer uses it to decide whether to send directly or queue what it submits
     */
    isBusy,
    /**
     * Sends the head of the input queue when idle and not paused (used by the queue's "Continue"; it is
     * also called internally when a round settles)
     */
    pumpQueue,
    /**
     * Roll back to before a given user message: stop the run, truncate the messages, clear the session
     * id; returns what is put back into the input box
     */
    rewindTo,
    newChat,
    error,
    setMessages,
    login,
    loginState,
    setupJobs,
    cancelSetup,
    install,
    installState,
    installError,
    config,
    saveConfig,
    clearKey,
    setupOpen,
    openSetup,
    closeSetup
  };
}
