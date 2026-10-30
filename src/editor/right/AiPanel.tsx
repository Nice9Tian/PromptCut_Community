import React, { useRef, useState, useEffect, useMemo } from "react";
import "./AiPanel.css";
// 公式样式表:LiveMarkdown 用 KaTeX 渲染数学,样式在这里一次性引入
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

/**
 * 一个 AI 助手分页。
 *
 * 这一层只做组合:对话(useAiChat)、会话归档、附件、草稿、诊断和各种开关的状态都在这里,
 * 画面交给 chat/ 下的组件。从上到下:顶栏 ChatHeader → 登录横幅 → 消息区 MessageList
 * → 思考条带 ThinkingStrip → 队列 QueueList → 输入区 Composer。
 */
export function AiPanel(props: { mcpConnected: boolean; hotkeysOff?: boolean; mock?: boolean; openSetupSignal?: number; tabId?: string; active?: boolean }) {
  // 多 Agent 分页:每页一个 AiPanel 实例,各自一份对话、一份会话归档 id;不在前台的页只是 display:none,对话照跑
  const tabId = props.tabId ?? MAIN_TAB;
  const active = props.active ?? true;
  const convRef = useRef<string | undefined>(undefined);
  // ?aimock=1 给界面自测用:走内置假流,不需要装好任何模型后端
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
   * 「云端」接入方式(云端 Agent 服务契约 9.5、10.4):只在项目放云端、文档服务报了这台托管端有云端 Agent 时才有这一项;
   * 本机仍是缺省,"云端"从不被自动选中,只记在这一页上(`tabMode`)。选了云端,这一页整个交给 CloudAiPanel(页面直连云节点,不经本机 Agent)。
   * `digest` 是打开项目后的一次 info 加一次对话列表:历史列表里「云端」一组与「云端对话进行中」的提示靠它,之后不轮询。
   */
  const cloud = useCloudAgent();
  const cloudTab = useCloudTab(tabId);
  const digest = useCloudDigest(cloud, cloud.available);
  useCloudNotices(cloud, cloud.available);

  // 顶栏标题就是这一页的页签名:Agent 用 declare_scope 声明范围之后会跟着改名
  const { tabs } = useAgentTabs();
  const tabTitle = tabs.find((t) => t.id === tabId)?.title ?? "AI 助手";

  // 页签上要知道这一页的对话 ID(给模型看的 Agent ID)和忙不忙
  // 开始页占位页还不是真会话(isDraft):点发送变成真页之后这两句才记得上
  const isDraft = tabs.find((t) => t.id === tabId)?.draft === true;
  useEffect(() => { setTabConversation(tabId, history.conversationId); }, [tabId, history.conversationId, isDraft]);
  useEffect(() => { setTabBusy(tabId, streaming); }, [tabId, streaming, isDraft]);

  // 刷新页面回来:非主页的对话不在 .proc 里,从会话归档按 id 找回
  useEffect(() => {
    if (isMainTab(tabId)) return;
    let alive = true;
    void getChat(history.conversationId).then((chat) => {
      if (alive && chat && chat.messages.length && messages.length === 0) setMessages(chat.messages);
    });
    return () => { alive = false; };
    // 只在挂上来那一刻找一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  /*
   * 别的 Agent 用 send_message 投来的消息(以及 spawn_agent 交给子 Agent 的任务):公告板在编辑器进程里
   * (server/agent/agent-board.mjs),推来的 agent.board 说这一页有可自动投递的消息时,这一页空闲就取走、
   * 当一条用户消息发出去;忙着就等这一轮跑完(streaming 翻回 false 时再来一次)—— 跑的途中它的工具结果里也会带上。
   * 自动连锁有层数上限(agentBus.MAX_AUTO_HOPS),到顶的消息留在信箱里,用户下次发消息时一并带上。
   */
  useEffect(() => {
    if (streaming) return;
    const convId = history.conversationId;
    let alive = true;
    const deliver = () => {
      // 用户自己排的队优先:队列里还有(暂停着也算)就先不投递,等用户那几句发完或删掉;
      // 驱动还没定下来(刚开的子 Agent 页签,驱动列表还在取)也先不取,取走了发不出去就丢了
      if (!alive || !provider || isBusy() || getQueue(tabId).length > 0) return;
      if (!agentBus.hasAutoDeliverable(convId)) return;
      void agentBus.takeInbox(convId, true).then((msgs) => {
        if (!msgs.length) return;
        if (!alive || isBusy() || getQueue(tabId).length > 0) {
          // 取走的这一小会儿里这一页又忙了(用户刚发了一句):先放回页面这边,这一轮跑完再送
          agentBus.stash(convId, msgs);
          return;
        }
        // 模型读 formatInbound 的全文;界面认 inbound 字段(不画成用户气泡,放进回复的操作详细预览控件)
        void send(agentBus.formatInbound(msgs), undefined, { inbound: msgs.map((x) => ({ from: x.fromLabel ?? x.from ?? "未知", text: x.text })), hops: Math.max(...msgs.map((m) => m.hops)) });
      });
    };
    deliver();
    const offBus = agentBus.subscribeBus(deliver);
    // 队列被删空 / 编辑走最后一条时,攒着的消息接着投
    const offQueue = subscribeQueue(deliver);
    return () => {
      alive = false;
      offBus();
      offQueue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, history.conversationId, provider]);
  // 关掉分页时这一页的队列跟着丢:队列只放内存,不跨分页、不跨刷新
  useEffect(() => () => clearQueue(tabId), [tabId]);

  const installJobs = useInstallJobs();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** 诊断报告子窗口:报告正文 + 开关 */
  const [diagReport, setDiagReport] = useState("");
  const [diagOpen, setDiagOpen] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  /** 输入框里的草稿。放在这一层而不是 Composer 里:预览右键引用卡片、空状态的示例句都要往里写 */
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 附件占位 id → 原始 File,失败重试时要用 */
  const retryFilesRef = useRef<Map<string, File>>(new Map());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 开始页(本项目一个会话都没有):消息区换成 StartHero;点预设往输入框放那句话,点发送才把占位页变成第一个会话
  const start = useStartPage(tabId, inputText, setInputText, () => { requestAnimationFrame(() => textareaRef.current?.focus()); }, messages.length > 0);
  // 这个项目只给了只读权限(游客):输入区整个置灰(Composer 的 readOnly),发送路径也在 handleSend 里兜底
  const ro = useReadOnly();

  // 预览右键卡片、时间轴右键片段或带里的叠加卡,都派发 pc-quote-clip(editor/quoteBus.ts),把引用插进输入框
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
        // 前面不是空白也不是开头,就补一个空格,免得和上一个词粘在一起
        const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const inserted = lead + ref + " ";
        // 重渲染之后再摆光标,让它停在引用之后
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

  // 简洁 / 详细、显示思考:所有分页共用一份(chat/viewPrefs),不是这一页自己的状态
  const { view, showThinking } = useViewPrefs();
  /** 展开的工具详情,键是 `消息id:片段序号`。纯界面状态,不写进消息里 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 摊开的「方块 ×N」,键是 `消息id:c块序号:r起点` */
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
   * 简洁模式下的小方块:同一时刻**只摊开一个**,点开新的就把上一个收掉。
   *
   * 和详细模式不一样:那边每个工具块自带标题行、就摆在它自己那一段的位置上,
   * 同时开几个也认得出谁是谁。简洁模式的详情是**统一摊在那一排方块下面**的,
   * 开两个就成了两坨挨着的 JSON,分不清各自对应上面哪个方块;方块行还会被
   * 越顶越高,想对照着看反而要来回滚。
   *
   * 用函数式更新而不是 toggleIn 那种读闭包里的 set:方块可能连着点,
   * 那样每次都从同一份旧集合算起,后一下会把前一下的结果盖掉。
   */
  const toggleChip = (key: string) =>
    setExpanded((prev) => (prev.has(key) ? new Set() : new Set([key])));

  /**
   * 折起来的「方块 ×N」:点开摊成单个方块,再点末尾的 ×N 收回去。
   * 收回时顺手把摊开的详情也关掉 —— 否则详情还挂在下面,对应的方块却已经看不见了。
   */
  const toggleRun = (key: string) => {
    if (openRuns.has(key)) setExpanded(new Set());
    setOpenRuns((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  // MessageRow 是 memo 的:回调经 ref 中转,引用永远不变,点开 / 收起走最新的那份闭包
  const handlersRef = useRef({ toggleTool, toggleChip, toggleRun });
  handlersRef.current = { toggleTool, toggleChip, toggleRun };
  const rowHandlers = useMemo(() => ({
    toggleTool: (k: string) => handlersRef.current.toggleTool(k),
    toggleChip: (k: string) => handlersRef.current.toggleChip(k),
    toggleRun: (k: string) => handlersRef.current.toggleRun(k),
  }), []);
  /** 「Agent 操作」显示哪一轮:缺省最新一轮,点气泡切过去 */
  const round = useRoundSelection(messages);

  /** 输入框里有没有东西(文字或附件):队列「编辑」、回退放回原话之前都要看它,有就先确认替换 */
  const hasDraft = () => inputText.trim().length > 0 || attachments.length > 0;

  /** 把光标放回输入框末尾(回退、队列「编辑」把内容放回去之后) */
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
   * 回退到某条用户消息之前(UserBubble 上确认过之后调)。步骤:
   *   1-3. useAiChat.rewindTo:在跑就先停并清掉编排状态、消息换成截断的那份、清掉这一页所有驱动的会话 id;
   *   4. 那条消息的原文和附件放回输入框;
   *   5. 会话归档立刻整份覆盖成截断后的那份(回退到第一条时是空列表,防抖存盘不会写空,见 useChatHistory.overwrite);
   *   6. 输入队列里的条目不动。回退打断了运行的话先暂停队列:用户正在改写,别让排着的话自己发出去。
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

  // 回退入口的回调经 ref 中转,引用永远不变:MessageRow 是 memo 的(理由同上面的 rowHandlers)
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
   * 把这段对话连同每一步的执行事件收成一份 JSON,摆进子窗口。
   * 密钥和模型私有思考在 conversationReport 里已经剔掉,这里不用再处理。
   *
   * 复制 / 保存为文件 / 提交三条出口都在子窗口里,由用户自己挑 —— 报告动辄几百 KB,
   * 以前替用户决定「这份该复制还是该存盘」,结果他既看不到报告也没得选。
   */
  // 收集要等一次本机请求,期间菜单项还点得动 —— 每点一次就多一轮采集
  const diagBusy = useRef(false);
  const openDiagnostics = async () => {
    if (messages.length === 0) return setToast("还没有对话可以导出");
    if (diagBusy.current) return;
    diagBusy.current = true;
    /*
     * 先收环境再开窗:模式、素材库、后端会话文件柜、Node 进程状态(见 ai/envCollect.ts)。
     * 少了这一段,「产品的 bug」和「这台机器的环境问题」在报告里一条都排除不掉。
     *
     * 收集要等一次本机请求,所以先说一声 —— 服务正好挂了的话这里会停满 5 秒,
     * 一个没有任何反馈的按钮会让用户以为点漏了,再点一次。
     */
    setToast("正在收集诊断信息…");
    let environment: unknown;
    try {
      environment = await collectEnvironment(messages.length);
    } catch (e) {
      // 收不到环境不该把整份报告一起弄丢:用户已经出问题了,对话本身是唯一的线索
      environment = { error: e instanceof Error ? e.message : String(e) };
    }
    try {
      setDiagReport(conversationReport(messages, provider, config, environment));
      setDiagOpen(true);
      setToast(null);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "诊断报告生成失败");
    } finally {
      diagBusy.current = false;
    }
  };
  /** 有事件被截断过就在子窗口顶上说一句,免得我们照着一份残缺报告查半天 */
  const diagTruncated = messages.some((m) => m.traceTruncated);

  // 这一页选了「云端」:整页交给云端对话界面;选回本机驱动时 CloudAiPanel 清掉标记、把选择交还这里
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

  // 一个驱动都没装:不给对话界面,只留一个进 AI 设置的入口
  if (providers.length > 0 && !providers.some(p => p.available)) {
    return (
      <aside className="panel panel-right ai-panel" data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
        <div className="ai-panel-header">
          <CollapsePanelButton placement="start" />
          <div className="ai-panel-title">AI 助手</div>
          <button className="ai-gear-btn" title="AI 设置" aria-label="AI 设置" onClick={openSetup}><span aria-hidden="true">⚙</span><span>AI 设置</span></button>
          <CollapsePanelButton placement="end" />
        </div>
        <div className="ai-empty-state">
          没找到 Claude Code / agy / Codex,装好任意一个后重启本地服务
          {cloud.available && (
            <div style={{ marginTop: 8 }}>
              <button className="ai-banner-btn" data-pc="ai-use-cloud" disabled={cloudOff} title={cloudOff ? cloudErrorText("disabled") : "项目放在云端,可以直接用云端 Agent"} onClick={() => selectCloudTab(tabId)}>改用云端 Agent</button>
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

  /** 假流不经过任何后端,别拿登录状态挡它;真后端没登录就弹横幅,返回 false */
  const passLoginGate = () => {
    if (!mock && needsLogin) {
      setShowLoginPrompt(true);
      return false;
    }
    setShowLoginPrompt(false);
    return true;
  };

  /**
   * 发送。text 由输入区交上来(Enter、「发送」或「加入队列」按钮),是那一刻输入框里的原文。
   *
   * 这一页正在跑(普通运行、分工模式、排着一次自动续跑都算)时不打断,排进输入队列,
   * 这一轮落定后由 useAiChat 按顺序自动发;空闲时照旧直接发。
   */
  const handleSend = (text: string) => {
    // 这个项目只给了只读权限(游客):不能给 Agent 发消息(输入区已置灰,这是别的发送路径的兜底)
    if (memberReadOnlyNow()) return;
    if (!passLoginGate()) return;
    if (!text.trim() && attachments.length === 0) return;
    // 开始页上点发送:这时才建第一个会话,这条消息在里面发出去
    start.commit();
    // 还在导入或导入失败的附件这次先不带上,但发送本身任何时候都不许被挡住
    const usable = attachments.filter((a) => a.status !== "importing" && a.status !== "error");
    const skipped = attachments.length - usable.length;
    if (skipped > 0) setToast(`${skipped} 个附件还在导入或导入失败,这次没带上`);
    if (isBusy()) {
      // 排一条空消息没有意义:只有没导好的附件时留在输入框里,等导好了再交
      if (!text.trim() && usable.length === 0) return;
      enqueue(tabId, { text: text.trim(), attachments: usable });
    } else {
      void send(text.trim(), usable);
    }
    setInputText("");
    setAttachments([]);
  };

  /** 「■ 停止」:停掉这一轮;队列里还有的暂停,不自动发,等用户点「继续」 */
  const handleStop = () => {
    if (getQueue(tabId).length > 0) setQueuePaused(tabId, true);
    abort();
  };

  /** 队列「插入」:这一条立刻发出去。在跑的话沿用 send() 开头的 abort 打断当前运行;队列里剩下的照常排着 */
  const insertQueued = (item: QueuedItem) => {
    if (!passLoginGate()) return;
    // 先发再出队(理由见 useAiChat.pumpQueue)
    void send(item.text, item.attachments);
    removeQueued(tabId, item.id);
  };

  /** 队列「编辑」:放回输入框并移出队列(输入框里原有内容要不要替换,QueueList 已经问过) */
  const editQueued = (item: QueuedItem) => {
    removeQueued(tabId, item.id);
    setInputText(item.text);
    setAttachments(item.attachments ?? []);
    focusComposerEnd();
  };

  /** 队列「继续」:解除暂停;空闲就马上发队首,还在跑就等这一轮落定 */
  const resumeQueue = () => {
    if (!passLoginGate()) return;
    setQueuePaused(tabId, false);
    pumpQueue();
  };

  /** 真正干活的后台导入：不 await 直接丢出去跑,跑完再回填那张卡片 */
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
            // 保留占位卡片的 id,这样重试和删除还能对得上
            return { ...a, ...job.attachment, id: placeholderId, status: "ready" as const };
          }
          return { ...a, status: "error" as const, error: job.error || job.attachment?.error || "导入失败", jobId: job.id };
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
      // 先把占位卡片插进去,这一步之前不许有任何 await,输入区一秒都不能卡
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

  /** 新对话:清掉这一页的消息,会话归档另起一个 id。「✦」菜单和历史抽屉顶上都有入口 */
  const startNewChat = () => {
    newChat();
    history.startNewChat();
  };

  return (
    <aside className="panel panel-right ai-panel" data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
      {/* SKILL 模式下整块盖住:项目正交给无头实例上的 agent 改,两边同时写会互相覆盖 */}
      <ChatHeader
        title={tabTitle}
        mcpConnected={props.mcpConnected}
        showThinking={showThinking}
        onChangeShowThinking={setShowThinking}
        onOpenHistory={() => { setHistoryOpen(true); history.refresh(); if (cloud.available) void digest.refresh(); }}
        onOpenSetup={openSetup}
      />

      {/* 云端有这位成员还在跑的对话(重新打开软件之后):提示一下,点了接上;不自动切到云端 */}
      {cloud.available && digest.running.length > 0 && (
        <div className="ai-banner" data-pc="cloud-running-banner">
          <span>云端有一个对话正在进行</span>
          <button className="ai-banner-btn" onClick={() => selectCloudTab(tabId, digest.running[0])}>接上看看</button>
        </div>
      )}

      {needsLogin && (
        <div className="ai-banner">
          <span>{pInfo.auth?.status === 'invalid' ? 'Codex 登录已失效，请重新登录' : showLoginPrompt ? "请先登录再发送" : `${pInfo.label} 还没登录`}</span>
          <button
            className="ai-banner-btn"
            onClick={() => { if (provider) login(provider); setShowLoginPrompt(false); }}
            disabled={st === "waiting"}
          >
            {st === "waiting" ? "登录窗口已打开,等你完成…" : st === "timeout" ? "登录超时,可以再试一次" : pInfo.auth?.status === 'invalid' ? '重新登录' : "去登录"}
          </button>
        </div>
      )}
      {/* 登录状态查不清(loggedIn 为 null)但服务端给了修复提示:照原话摆出来 */}
      {!needsLogin && pInfo?.auth?.loggedIn === null && pInfo.auth.fixHint && (
        <div className="ai-banner">
          {pInfo.auth.fixHint}
          <button className="ai-banner-btn" onClick={openSetup}>打开 AI 设置</button>
        </div>
      )}

      {/* 共享项目里别的成员那边的 Agent 在改哪儿(A3 第二阶段,经文档服务的在场状态) */}
      <RemoteAgentsStrip />
      {/* 桌面 APP 的会话(SKILL,计划 A4):每个会话单独一组,厂商 + 正在进行的操作 + 进度报告 */}
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

      {/* 「Agent 操作」:这个对话按轮显示的操作与汇报(取代按项目频道列的「Agent 操作记录」,2026-10-20 用户定);写了项目的那一步在详细预览里能撤 */}
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
        title="对话诊断报告"
        label="对话诊断"
        hint={diagTruncated ? "含可见对话与每一步执行事件;过大的事件已截断" : "含可见对话与每一步执行事件;不含密钥与模型私有思考"}
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
