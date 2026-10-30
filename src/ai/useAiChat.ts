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

/** 回退时这一页每家驱动的会话 id 都要清,清单在这里 */
const ALL_PROVIDERS: AiProvider[] = ["claude", "agy", "codex", "api"];

/**
 * 把素材库里的素材整理成附件清单的形状,跟着每次发送一起带上(服务端单列成「素材库」一段)。
 *
 * url 给卡片能直接引用的 /@media/<文件名>,**不给磁盘路径**:以前给的是 path,
 * 模型没有任何能读磁盘的工具,却每轮都被这串路径引着去 Read、去 curl(见 mediaRef.ts)。
 * 还没上传完、换算不出 cardUrl 的先不列,免得给出一个用不了的地址。
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

/** 给最近一个同名、还没有结果的工具片段补上结果 */
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
 * 首启设置对话框这一次页面加载只弹一次:以前认「主页」这一页去弹;分页清单按项目分开、
 * 第一个会话不再是固定的「main」之后,谁先走到这里谁弹。
 */
let setupGateClaimed = false;
function claimSetupGate(): boolean {
  if (setupGateClaimed) return false;
  setupGateClaimed = true;
  return true;
}

export function useAiChat(opts?: { mock?: boolean; tabId?: string; getConversationId?: () => string | undefined }) {
  // 对话归项目所有(要随 .proc 存取、随项目切换),所以放在组件外的 store 里。
  // 多 Agent 分页:每页一份 store,主页(MAIN_TAB)那份才随 .proc 存取
  const tabId = opts?.tabId ?? MAIN_TAB;
  const store = getChatStore(tabId);
  const setMessages = store.set;
  const messages = useChatMessages(store);
  // CLI 驱动的会话 id 也按页分开:两页共用一个 sessionId 等于两个 Agent 接着同一段对话说
  const sessKey = (p: string) => (isMainTab(tabId) ? `aiSession:${p}` : `aiSession:${p}:${tabId}`);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sttInfo, setSttInfo] = useState<SttInfo | null>(null);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [sessionIds, setSessionIds] = useState<Partial<Record<AiProvider, string>>>({});
  /**
   * 自动续跑还剩几次。用户每发一条新消息就重置成 1 ——
   * 「一轮用户输入最多自动接一次」,不给无限循环留口子。
   */
  const autoContinueLeftRef = useRef(1);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setupOpen, setSetupOpen] = useState(false);
  const [loginState, setLoginState] = useState<Partial<Record<AiProvider, LoginState>>>({});
  const [config, setConfig] = useState<PublicAiConfig | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  /*
   * 一轮的生命周期,给输入队列用(见 chatQueue.ts、下面的 pumpQueue):
   * - sendSeqRef:每次 abort()(包括 send 开头那一次)加一。一轮落定时序号没变,
   *   才说明它既没被用户停掉、也没被新的一次发送顶掉;
   * - busyRef:send 开始到这一轮落定之间为 true。和 streaming 不同,它是同步读的;
   * - autoContinueTimerRef:出错自动续跑已经排上、还没发出去的那一次;
   * - workflowRef:一键配特效正在串行跑,队列等它跑完再发。
   */
  const sendSeqRef = useRef(0);
  const busyRef = useRef(false);
  const autoContinueTimerRef = useRef<number | null>(null);
  const workflowRef = useRef(false);
  const unmountedRef = useRef(false);
  /** 最新一次渲染的 send。落定后发队首、自动续跑都用它:旧闭包里那份的 provider / config 可能已经换了 */
  const sendRef = useRef<(text: string, attachments?: ChatAttachment[], sendOpts?: { auto?: boolean; hops?: number }) => Promise<boolean>>(async () => false);
  // 这一页被关掉(多 Agent 分页关页)时把还在跑的请求掐掉:连接一断服务端就会 abort 那一轮
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
  /** CLI 安装:idle | installing | ok | timeout | failed */
  const [installState, setInstallState] = useState<Partial<Record<AiProvider, "idle" | "installing" | "ok" | "timeout" | "failed">>>({});
  const [installError, setInstallError] = useState<Partial<Record<AiProvider, string>>>({});


  useEffect(() => {
    if (opts?.mock) {
      setProviders([
        { id: "claude", label: "Claude Code", available: true, version: "2.1.221", auth: { loggedIn: false, loginCommand: ["claude", "auth", "login"] } },
        { id: "codex", label: "Codex", available: true, version: "0.136.0", auth: { loggedIn: null, detail: "unknown variant ultra, expected one of none|minimal|low|medium|high|xhigh", fixHint: "codex 配置文件 ~/.codex/config.toml 第 5 行的 model_reasoning_effort 值本版 codex 不认,改成 high 或 xhigh 后再试", loginCommand: ["codex", "login"] } },
        { id: "agy", label: "Antigravity", available: true, version: "1.1.27", auth: { loggedIn: true } },
        { id: "api", label: "API 直连", available: false, note: "还没填 API Key", auth: { loggedIn: false, detail: "还没填 API Key" } }
      ]);
      setConfig({ version: 1, defaultProvider: null, toolProtocol: true, api: { vendor: "anthropic", baseUrl: "", model: "gpt-4o|gpt-4o-mini", maxTokens: 4096, apiKey: { set: false, last4: "" }, source: "" }, keys: { custom: { set: false, last4: "" }, router: { set: false, last4: "" } }, cliModels: { claude: "opus|sonnet|haiku", codex: "gpt-5.6-terra|gpt-5.6-sol", agy: "gemini-3.8-flash-high|gemini-3.8-flash-medium|gemini-3.8-flash-low|gemini-3.1-pro-high|gemini-3.1-pro-low|claude-sonnet-4-6" } });
      setProvider("claude");
      // ?nosetup=1 给自动化脚本用:不弹首启设置对话框
      if (localStorage.getItem("aiSetupDone") === null && !new URLSearchParams(location.search).has("nosetup") && claimSetupGate()) {
        setSetupOpen(true);
      }
      return;
    }

    fetch("/api/ai/config")
      .then((res) => res.json())
      // 桥统一用 { ok, config } 信封(和其他接口一致);兼容裸 publicConfig
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
        // spawn_agent 拉起的子 Agent 沿用父对话的驱动(A3):这一页拉起时就定下了,不跟全局的选择走
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
          setError("获取 AI 供应商失败：" + e.message);
        } else {
          setError("获取 AI 供应商失败");
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
      // ?nosetup=1 给自动化脚本用:不弹首启设置对话框
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
        if (!res.ok) throw new Error('无法获取安装和登录进度');
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
        if (!stopped) setSetupJobs(prev => prev.map(j => j.state === 'running' ? { ...j, message: '连接中断，正在重新获取进度…' } : j));
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
      if (!res.ok || !data.ok) throw new Error(data.error || '请求失败');
      setSetupJobs(prev => [...prev.filter(j => j.provider !== id), data.job]);
    } catch (e) {
      const message = e instanceof Error ? e.message : '请求失败';
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
      if (!res.ok) throw new Error('取消失败，请重试');
    } catch (e) { setError(e instanceof Error ? e.message : '取消失败'); }
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
        // 假流也要照着真接口合并:漏掉哪个字段,界面上对应的开关就会在保存后
        // 弹回原值,看着像 bug 其实是假流没跟上(toolProtocol 就这么坑过一次)
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
      setError("保存配置失败");
      throw e;
    }
  }, [opts?.mock]);

  /** 「清理密钥」:删掉那一路的密钥文件,拿回最新配置 */
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
    if (!res.ok || !data?.ok) throw new Error(data?.error || "清理密钥失败");
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
    // 换模型不动对话:对话属于这个项目,换个模型接着聊是合理的
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
    // 先让正在跑的这一轮「过期」:它之后落定时序号对不上,就不会去发队首
    sendSeqRef.current += 1;
    busyRef.current = false;
    // 还没发出去的自动续跑一并取消:用户停了就是停了,新发的消息也不该被续跑打断
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

  /** 这一页此刻算不算在跑:发送进行中,或者排着一次自动续跑。Composer 交上来的话据此决定直接发还是进队列 */
  const isBusy = useCallback(() => busyRef.current || autoContinueTimerRef.current !== null, []);

  /**
   * 空闲时发出输入队列的队首。调用点:一轮真正落定(finishRun)、用户点「继续」、一键配特效跑完。
   * 暂停着、还排着一次自动续跑、一键配特效没跑完、此刻还在忙,都不发 —— 不会出现两条同时发出去。
   *
   * 先发再出队:send 的同步部分已经把 busyRef 置上,出队触发的订阅(AiPanel 里 agentBus 的自动投递)
   * 看到的就是「忙」,不会趁这一下空当再塞一条进来。
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

  /** 一轮真正落定(增量已 flush、outcome 已写进消息,而且没被停掉 / 顶掉)时调 */
  const finishRun = useCallback(() => {
    busyRef.current = false;
    pumpQueue();
  }, [pumpQueue]);

  /**
   * 回退到某条用户消息之前。入口在 UserBubble,确认之后由 AiPanel 调;返回 null 表示 id 不对。
   *   1. 正在跑就先停,分工模式的编排状态一并清掉(换代,旧编排晚到的更新不再写回来);
   *   2. 这一页的消息换成截断后的那份;
   *   3. 这一页**所有驱动**的会话 id 都清掉:下一次发送后端从头开会话,留下的几轮由「前情」带过去(buildHandoff)。
   * 放回输入框、归档整份覆盖由 AiPanel 接着做;输入队列不动。
   */
  const rewindTo = (userMessageId: string): RewindResult | null => {
    if (!rewindAt(store.get(), userMessageId)) return null;
    if (busyRef.current || autoContinueTimerRef.current !== null || abortControllerRef.current) abort();
    // abort() 会把还在跑的消息标成已中止,按标完之后的那份再算一遍
    const result = rewindAt(store.get(), userMessageId);
    if (!result) return null;
    setMessages(result.kept);
    for (const p of ALL_PROVIDERS) {
      try {
        localStorage.removeItem(sessKey(p));
      } catch {
        /* 存储不可用就只清 state */
      }
    }
    setSessionIds({});
    return result;
  };

  // 第三个参数叫 sendOpts 不叫 opts:这个函数体里到处在读**外层 hook 的** opts
  // (opts.mock、opts.getConversationId),重名会把它整个遮住,而且遮得悄无声息 ——
  // 类型对不上才炸出来,不然就是运行时读到 undefined。
  //
  // 返回这一轮是否正常落定(没被停掉、没被新的发送顶掉);一键配特效据此决定还跑不跑下一个角色。
  // sendOpts.inbound:这条其实是其他 Agent 发来的消息(AiPanel 自动投递),原样挂到用户消息上给界面认
  // sendOpts.hops:这条是第几层自动投递(别的 Agent 的消息,A3),服务端的公告板据此给连锁封顶
  const send = async (text: string, attachments?: ChatAttachment[], sendOpts?: { auto?: boolean; inbound?: ChatMessage["inbound"]; hops?: number }): Promise<boolean> => {
    if (!provider) return false;
    // 用户自己发的才重置额度;自动续跑那次不重置,否则「续跑 → 又错 → 再续」能一直转下去
    if (!sendOpts?.auto) autoContinueLeftRef.current = 1;

    abort();
    // 这一次发送的序号:每个 await 回来都对一下,对不上就是中途被停掉或被顶掉了
    const seq = sendSeqRef.current;
    busyRef.current = true;

    // 用户那句话**发送的这一瞬间**就进消息流
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      text,
      attachments,
      ...(sendOpts?.inbound?.length ? { inbound: sendOpts.inbound } : {}),
    };
    setMessages((prev) => [...prev, userMsg]);

    // 发送这一刻就把「这条用什么跑」定下来,而且**发出去的和记下来的是同一份**。
    // 分开各读一次的话,用户在流式过程中换了模型,记录就会和实际跑的对不上。
    const choice = readChoice(provider);
    /*
     * 模型名在这里再过一道清单。面板上早就这么做了(normalizeModel),但那只管下拉框
     * 显示成什么;发请求一直用的是 localStorage 里的原值。于是一个已经不在清单里的
     * 名字——设置改过、或者当初就手打错了一个字符——界面上显示「默认」,请求里却
     * 照旧带着它。CLI 拿到不存在的模型名当场退出,用户什么提示都看不到。
     * 显示和实际跑的必须是同一个值。
     */
    choice.model = normalizeModel(choice.model, modelsFor(provider, config));
    /*
     * agy 的模型名和思考档必须配对(gemini-3.8-flash-low 配 --effort high 会被它当场拒),
     * 而且每个模型自己有哪几档不一样。面板上是「基名 + 档位」两个框,发出去之前在这里
     * 拼成 agy 认的那一对;别的驱动原样返回。
     */
    {
      const pair = pairModelEffort(provider, choice.model, choice.effort, config);
      choice.model = pair.model;
      choice.effort = pair.effort;
    }
    /*
     * 档位也要按清单兜一道 —— 和上面 normalizeModel 是同一个道理,而且踩过同一种坑。
     *
     * 档位存在 localStorage 里。清单改过之后(0ae554b 把 codex 的 `minimal` 去掉了,
     * 因为上游根本不认、选中必 400),老用户浏览器里那个值还在。ModelBar 只把它降级成
     * 「默认」**显示**,发请求这条路读的是 localStorage 原值 —— 于是界面上写着「默认」,
     * 请求里照旧带着 minimal,还是那条 400。显示和实际跑的必须是同一个值。
     */
    choice.effort = sanitizeEffort(provider, choice.model, choice.effort, config);
    // 参数兼容模式:锁死的驱动 / 模型不听本地偏好,按策略定论;可调的把偏好交给服务端
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

    // 用户消息上面已经进去了,这里只追加助手那条
    setMessages((prev) => [...prev, asstMsg]);
    setStreaming(true);
    setError(null);

    if (opts?.mock) {
      let i = 0;
      const msg = "这是内置假流回复内容。我将调用一个工具看看效果。";
      const timer = setInterval(() => {
        // 被停掉或被新的发送顶掉:假流也跟着停,别往已中止的消息里接着写、也别事后把 streaming 关掉
        if (seq !== sendSeqRef.current) {
          clearInterval(timer);
          return;
        }
        if (i < msg.length) {
          // 每帧写「到目前为止的整段文字」,不做增量拼接:
          // 第一次 tick 有可能赶在助手消息真正入列之前,那一次增量更新会静默丢掉,
          // 后面每个字就都错开一位(开头少一个字、结尾多一个 undefined)。
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
                tools[0].summary = "获取成功";
              }
              const parts = completeToolPart(m.parts, { name: "get_editor_state", ok: true, summary: "获取成功" });
              return { ...m, tools, parts };
            }));
            // 工具跑完之后再说一句:详细模式下应当出现「文字 → 工具 → 文字」的真实顺序
            // 这段同时充当渲染样张:表格、行内公式、独占一行的公式都在里面
            const tail = [
              "工具返回了,时间轴现在是空的。建议这样排:",
              "",
              "| 卡片 | 起 | 止 |",
              "| --- | ---: | ---: |",
              "| 金句卡 | 3.0 | 8.0 |",
              "| 数字滚动 | 8.0 | 10.5 |",
              "",
              "每张卡的时长 \\(d = t_1 - t_0\\),整段导出帧数:",
              "",
              "$$N = \\lceil (t_1 - t_0) \\times fps \\rceil$$",
            ].join("\n");
            setTimeout(() => {
              if (seq !== sendSeqRef.current) return;
              setMessages(prev => prev.map(m => m.id === asstMsgId
                ? { ...m, text: m.text + "\n" + tail, parts: appendTextPart(m.parts, "\n" + tail), pending: false, outcome: "completed" }
                : m));
              setStreaming(false);
              // 假流这一轮落定:和真实流一样在这里发队首
              finishRun();
            }, 600);
          }, 1000);
        }
      }, 50);
      return true;
    }

    const ac = new AbortController();
    abortControllerRef.current = ac;
    /** 这一轮是否正常落定(见 finally 里发队首的那段) */
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
       * 会话 id 以 **localStorage 为准**,不用组件里那份 state。
       *
       * 换项目时 projectAi.applyProjectAi 会把 `aiSession:*` 全清掉(理由见那边),
       * 但它清不到这个 hook 的 state —— 读 state 的话,换了项目第一句还是会带着
       * 上个项目的会话 id 发出去,服务端照旧把那边的历史整段读回来。
       * state 留着只为显示;决定「接哪段历史」的必须是同一个真相源。
       */
      const sessionId = (() => {
        try { return localStorage.getItem(sessKey(provider)) || undefined; }
        catch { return sessionIds[provider]; }
      })();
      // 多 Agent:这一页的对话 ID 随请求带上,服务端把它塞给 MCP 进程,工具调用就知道是谁发的;
      // 其他 Agent 的动态(范围变动、给它的消息)由服务端的公告板拼在提示词前面(A3)—— 只进模型,不进屏幕上那条用户消息
      const agentId = opts?.getConversationId?.();
      // 换了模型:把这家没见过的那几轮摘成「前情」一起带上(理由见 handoff.ts)。
      // 刚追加的这一问一答不算历史
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
          // 模型 / 推理强度 / 加速档:上面发送那一刻已经读好(choice),用户在面板上
          // 换完下一条立刻生效。哪家支持哪几样由 runner 端翻译,这里只管把选择传过去。
          ...choice,
          // 素材库里的东西一并列进附件清单:模型不用先花一轮 list_media 才知道
          // 手上有哪些素材,「给每个视频配字幕」这类要求也才有确定的对象。
          attachments: [...(attachments ?? []), ...mediaAsAttachments()],
          // 剧本每一轮都带上,由服务端拼进系统提示词 —— 多轮跑下来最容易跑偏,
          // 只在第一条消息里说一次是拉不住的。
          script: getScript(),
          // 创造力等级:这一页单独设的(null = 跟项目)和项目这一刻的默认等级。服务端的闸门按它们判越级调用,
          // 项目默认以服务端读到的项目为准,读不到才用这里报的(server/vite-plugin-ai.ts 的 currentProjectCreativity)
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
          // 文字和思考增量排队合并(思考只进 parts,不进 m.text,见 applyDeltas)
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
             * 可续跑的中断:自动接着说一句,别让用户去点重试。
             *
             * 上下文不用我们搬 —— CLI 那几条路都带 `--conversation <id>`,agy 会把整段
             * 对话原样带回来;要补的只是「刚才为什么停」,那句话由驱动拼好放在 retryPrompt 里
             * (里面直接带着被拒的原始说明),这里原样发出去,模型不必自己开口问。
             *
             * **只续一次**。哪些错值得续由驱动判定(密钥错、模型名错、额度光了都不带这个标记),
             * 但判定不可能永远对;万一续了还是同一个错,再续就是无限循环,在用户的额度上烧。
             * 一次不成就停在那儿,把错误留给用户看 —— 他知道的比我们多。
             * 用户自己发新消息时额度重置(见 send 开头)。
             */
            if (!ev.authReason && ev.retryable && ev.retryPrompt && autoContinueLeftRef.current > 0) {
              autoContinueLeftRef.current -= 1;
              const prompt = ev.retryPrompt;
              // 记下这次排着的续跑:发出去之前这一页仍算忙,输入队列不能抢在它前面(见 pumpQueue);
              // 用户在这之前点了停止,abort() 会把它取消
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
              ? { ...m, error: "发生错误: " + e.message, pending: false, finishedAt: Date.now(), outcome: "error" }
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
       * 输入队列的自动发送挂在这里:走到 finally 时增量已经 flush、outcome 已经写进消息,这一轮才算真正落定。
       * 序号没变 = 没被用户停掉(停掉的那次 outcome 是 aborted)、也没被新的发送顶掉;
       * 连接被卸载掐断(关分页)的也不算。还排着一次出错自动续跑的话,pumpQueue 会让续跑先走。
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
   * 一键配特效:按顺序把 src/ai/roles/ 里的角色各跑一轮。
   *
   * 串行而不是拼成一段长提示词 —— 剪辑导演要先看齐全部素材才排得了片,
   * 特效助理要先有文字稿才配得了字幕和动效,合在一轮里模型会顾此失彼。
   * 每一轮都是完整的一次 send,所以被用户停掉之后,后面的角色不会再跑。
   *
   * 跑着的时候输入队列先等着(pumpQueue 看 workflowRef):不然前一个角色一落定就发队首,
   * 下一个角色一开跑又把它打断。整串跑完再发。
   */
  const runWorkflow = useCallback(async () => {
    workflowRef.current = true;
    try {
      for (const role of WORKFLOW_ROLES) {
        // 没正常落定(用户按了停止、被别的发送顶掉)就别继续下一个角色了
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
    /** 此刻算不算在跑(同步读,含排着的自动续跑);Composer 交上来的话据此决定直接发还是进队列 */
    isBusy,
    /** 空闲且没暂停时发出输入队列的队首(队列「继续」用;一轮落定时内部自己会调) */
    pumpQueue,
    /** 回退到某条用户消息之前:停掉运行、截断消息、清会话 id;返回放回输入框的内容 */
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
