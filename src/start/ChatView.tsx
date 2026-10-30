/**
 * 聊天页:侧栏里点一条项目 Agent(云端 Agent 对话)就进这里(界面形状用户 2026-10-23 定)。
 *
 * 形状照手机 App 里那种对话:中间是消息,下面是贴底的输入框。自己说的话靠右、强调色气泡;Agent 说的话靠左、
 * 面板色气泡,前面放一个星芒头像 —— 和编辑器右栏那套一致(`src/editor/right/chat/MessageList.tsx`)。
 *
 * 2026-10-23 接上业务层(`docs/reports/AGENT-claude-vibe-wire.md`):消息、发送、停止都是真的,数据和动作由
 * 调用方按 `vibeAgent.ts` 的 `VibeAgent` 给 —— 在线浏览器是云端 Agent(`useVibeCloud.ts`),桌面版是本机的
 * CLI / API Agent(`useVibeLocal.ts`,和编辑界面 AI 栏同一套)。这一页对两种一视同仁,不认具体是哪一种。
 *   - 一轮回复按 `product/agent.md`「汇报」拆:气泡里只放 Agent 说的「在做什么」,做过的操作列在「Agent 操作」那一块
 *     (拆法与手机版共用 `src/mobile/agentView.ts` 的 `roundView`);
 *   - 自己的消息云端还没收下之前写明发送状态,没发出去写原因;共有对话里别人发的标上是谁;
 *   - 对话是空的时候只有一条示例句(`workflow/production.md`「用户发送指令」),点它填进输入框;
 *   - 发不了(只读成员、创建者看别人的私有对话、开关关着)时输入框置灰,下面那一行写为什么。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { LiveMarkdown } from "../ai/Markdown";
import type { ChatMessage } from "../ai/types";
import { OUTBOX_RESEND_EVENT, OUTBOX_TEXT } from "../ai/outbox";
import { activityText, outcomeText, runningTool } from "../editor/right/chat/AgentBubble";
import { START_PRESET } from "../editor/right/chat/StartHero";
import { CloudAgentConsentDialog } from "../editor/right/CloudAgentConsentDialog";
import { isUserBubble, ordinals, partsOf, roundView, splitQuotes } from "../mobile/agentView";
import { selectionPresenceStatus } from "../editor/sync/selectionPresence";
import { ChatSidePanel } from "./ChatSidePanel";
import { Composer } from "./Composer";
import { DetailEdit } from "./DetailEdit";
import type { VibeAgent } from "./vibeAgent";

/** 开始页那句话自动发出之前,选区连上之后再等多久(毫秒):给文档服务登记这张页面留的余量 */
const PENDING_SETTLE_MS = 2000;

const MARK: Record<string, string> = { done: "✓", run: "…", todo: "·", err: "!", ask: "!" };

function AgentAvatar(): JSX.Element {
  return (
    <span className="ps-msg-avatar" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
      </svg>
    </span>
  );
}

function MyMessage(props: { m: ChatMessage; sender: string | null }): JSX.Element {
  const { m } = props;
  const { quotes, rest } = splitQuotes(m.text);
  const failed = m.sendState === "failed";
  return (
    <div className="ps-msg is-me" data-pc="start-chat-msg" data-from="me" data-send={m.sendState}>
      <div className="ps-me-col">
        {props.sender && <span className="ps-msg-sender" data-pc="start-chat-sender">{props.sender}</span>}
        <div className="ps-bubble">
          {quotes.map((q) => `@${q.label} `).join("")}
          {rest}
        </div>
        {m.sendState === "sending" && <span className="ps-msg-state">发送中…</span>}
        {m.sendState === "accepted" && <span className="ps-msg-state">已发出，等待云端开始处理…</span>}
        {m.sendState === "queued" && <span className="ps-msg-state">{OUTBOX_TEXT.queued}</span>}
        {m.error && <span className="ps-msg-state is-err" data-pc="start-chat-send-error">{m.error}</span>}
        {failed && m.resendable && (
          <button type="button" className="ps-link" onClick={() => window.dispatchEvent(new CustomEvent(OUTBOX_RESEND_EVENT, { detail: { id: m.id } }))}>
            {OUTBOX_TEXT.resend}
          </button>
        )}
      </div>
    </div>
  );
}

function AgentMessage(props: { m: ChatMessage; ordinal: number }): JSX.Element {
  const { m } = props;
  const v = roundView(m, props.ordinal);
  const live = !!m.pending;
  const sayings = [...v.before, ...v.after];
  const lastText = sayings.filter((s) => s.from === "text").pop();
  const outcome = live ? null : outcomeText(m);
  return (
    <div className="ps-msg is-agent" data-pc="start-chat-msg" data-from="agent" data-live={live || undefined}>
      <AgentAvatar />
      <div className="ps-msg-body">
        {v.before.map((s) => (
          <div key={s.key} className="ps-msg-text ps-md"><LiveMarkdown text={s.text} live={live && s === lastText} /></div>
        ))}
        {v.hasCard && (
          <div className="ps-actions" data-pc="start-chat-actions">
            <div className="ps-actions-head">Agent 操作 · {v.title}</div>
            <ul className="ps-actions-list">
              {v.items.map((it) => (
                <li key={it.key} data-state={it.state}><span className="ps-op-mark">{MARK[it.state]}</span>{it.kind} · {it.name}</li>
              ))}
              {v.reports.flatMap((r, i) => [
                <li key={`r${i}`} className="ps-op-report">{r.title}</li>,
                ...r.rows.map((row, j) => <li key={`r${i}-${j}`} data-state={row.state}><span className="ps-op-mark">{MARK[row.state]}</span>{row.text}</li>),
              ])}
            </ul>
          </div>
        )}
        {v.after.map((s) => (
          <div key={s.key} className="ps-msg-text ps-md"><LiveMarkdown text={s.text} live={live && s === lastText} /></div>
        ))}
        {live && <p className="ps-msg-text ps-msg-live" data-pc="start-chat-typing">{activityText(m, runningTool(partsOf(m)))}</p>}
        {!live && !sayings.length && !v.hasCard && !m.error && !outcome && <p className="ps-msg-text ps-msg-live">（这一轮没有留下文字）</p>}
        {m.error && <p className="ps-msg-text ps-msg-err" role="alert" data-pc="start-chat-error">{m.error}</p>}
        {outcome && <p className="ps-msg-text ps-msg-live">{outcome}</p>}
        {m.cloudRender && <p className={`ps-msg-text ps-msg-live${m.cloudRender.state === "failed" || m.cloudRender.state === "unavailable" ? " ps-msg-err" : ""}`}>{m.cloudRender.text}</p>}
      </div>
    </div>
  );
}

export function ChatView(props: {
  vibe: VibeAgent;
  /** 对话标题(顶栏上那一行);这里输入框的占位文字要用 */
  title: string;
  /** 开始页上说的那句话:进了聊天页自动发出去一次(发过就由上层清掉) */
  pending: string | null;
  onPendingSent: () => void;
  /** 右边那条拓展栏开着没有。开关在顶栏上(`TopBar.tsx`),所以状态拿在 `OnlineStart` */
  panel: boolean;
  /** 切到传统式(打开编辑界面);按钮在「详细编辑」的头上 */
  onPro: () => void;
  ext: {
    width: number;
    onWidth: (px: number) => void;
    onWidthCommit: (px: number) => void;
    onWidthNudge: (delta: number) => void;
  };
}): JSX.Element {
  const { vibe } = props;
  const messages = vibe.chat.messages;
  const [text, setText] = useState("");
  /** 拓展栏、详细编辑里点出来的那句说明,显示在输入框下面 */
  const [note, setNote] = useState("");
  const [detail, setDetail] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const convId = vibe.chat.conversationId;

  // 换一条对话:没发出去的草稿不带过去。开始页带过来的那句话先放进输入框(看得见),就绪后自动发出;
  // 没能发出去(拒绝了告知)就一直留在输入框里,不用重打
  useEffect(() => {
    setText(props.pending ?? "");
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);
  useEffect(() => { if (props.pending) setText(props.pending); }, [props.pending]);
  useEffect(() => { tail.current?.scrollIntoView({ block: "end" }); }, [messages]);

  /*
   * 输入框此刻在哪(用户 2026-10-26 定,issue #4):详细编辑展开、拓展栏又开着时，它在拓展栏里那块
   * 聊天面板的底部；其余三种组合都在聊天列底部。
   *
   * 所以人自己把拓展栏收了(顶栏最右那颗 `start-chat-ext-toggle`)，输入框就掉回聊天列底部，
   * 详细编辑照开 —— 两颗开关各管各的，哪种组合都有地方说话。issue #4 嫌的是「默认就长在时间轴
   * 正下方」，不是这个位置绝对不能用。
   *
   * 两处是同一个 `text`,草稿自己跟着走;换了地方 textarea 要重挂，焦点在这里补回来。
   */
  const inPanel = detail && props.panel;
  const placed = useRef(inPanel);
  useEffect(() => {
    if (placed.current === inPanel) return;
    placed.current = inPanel;
    area.current?.focus();
  }, [inPanel]);

  const send = async (body: string) => {
    const t = body.trim();
    if (!t) return;
    setText("");
    const ok = await vibe.send(t);
    // 没发出去(还没确认告知、被拒):原文放回输入框,不让人重打
    if (!ok) setText((cur) => cur || t);
  };

  // 开始页上说的那句话:对话就绪(能发了)就发一次
  // 还要等这张页面的选区在文档服务那边登记上:账号模式发消息带的是这张页面的选区快照,刚进项目那一下文档服务还没有这张页面,
  // 立刻发会被拒(`selection-page-unavailable`)。手动发不会撞上(人打字比它慢),自动发的这一条等选区连上之后再等一小会儿
  const pendingSent = useRef<string | null>(null);
  useEffect(() => {
    const p = props.pending;
    if (!p || pendingSent.current === p || !vibe.canSend || !vibe.chat.history.loaded) return;
    let dead = false;
    let timer = 0;
    const t0 = Date.now();
    const tick = () => {
      if (dead) return;
      const presence = selectionPresenceStatus();
      if (!(presence.linked && presence.pageId) && Date.now() - t0 < 15_000) { timer = window.setTimeout(tick, 300); return; }
      timer = window.setTimeout(() => {
        if (dead || pendingSent.current === p) return;
        pendingSent.current = p;
        props.onPendingSent();
        void send(p);
      }, PENDING_SETTLE_MS);
    };
    tick();
    return () => { dead = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pending, vibe.canSend, vibe.chat.history.loaded]);

  const stopMode = vibe.streaming && text.trim().length === 0;
  const order = ordinals(messages);
  const meId = vibe.me;
  const senders = vibe.chat.view.senders ?? {};
  const shown = messages.filter((m) => m.role === "assistant" || isUserBubble(m));

  const footNote = note
    || (vibe.whyNot && vibe.projectId ? vibe.whyNot : "")
    // 云端的执行服务没在接活:和编辑器右栏同一句(`CloudAiPanel.tsx` 的 cloud-note)。本机 Agent 没有执行服务,恒为假
    || (vibe.waitingExecutor ? "消息会持久排队，等待执行服务；重新打开可接着看。" : "")

    || (vibe.queued > 0 ? `前面还有 ${vibe.queued} 条在排队，一轮一轮跑。` : "")
    || vibe.hint;

  // 同一个输入框,两个落点:要么在聊天列底部,要么在拓展栏那块面板里(见上面 `inPanel`)
  const composer = (
    <Composer
      text={text}
      onText={setText}
      onSend={() => void send(text)}
      onStop={() => void vibe.stop()}
      area={area}
      canSend={vibe.canSend}
      canStop={vibe.canStop}
      stopMode={stopMode}
      placeholder={vibe.canSend ? `对「${props.title}」说点什么` : (vibe.whyNot ?? "")}
      note={footNote}
      narrow={inPanel}
    />
  );

  return (
    <main className="ps-main ps-chat" data-pc="start-chat" data-chat={convId}>
      <div className="ps-chat-row">
        <div className="ps-chat-col">
          {vibe.banner && (
            <div className="ps-chat-banner" role="alert" data-pc="start-chat-banner" onClick={vibe.clearBanner}>{vibe.banner}</div>
          )}
          {detail ? (
            <DetailEdit
              onPro={props.onPro}
              onClose={() => setDetail(false)}
              onQuote={(q) => {
                setText((t) => (t.trim() ? `${t.trimEnd()} ${q} ` : `${q} `));
                area.current?.focus();
                setNote(`已把「${q}」放进输入框。`);
              }}
            />
          ) : (
            <div className="ps-chat-scroll">
              <div className="ps-chat-list" data-pc="start-chat-list">
                {shown.length === 0 && (
                  <div className="ps-chat-empty" data-pc="start-chat-empty">
                    {vibe.canSend ? (
                      <button type="button" className="ps-chat-example" data-pc="start-chat-example" onClick={() => { setText(START_PRESET); area.current?.focus(); }}>
                        {START_PRESET}
                      </button>
                    ) : (
                      <p className="ps-muted">{vibe.whyNot ?? "正在连接云端 Agent…"}</p>
                    )}
                  </div>
                )}
                {shown.map((m) => {
                  if (m.role === "user") {
                    const s = senders[m.id];
                    return <MyMessage key={m.id} m={m} sender={s && s.accountId !== meId ? s.name : null} />;
                  }
                  return <AgentMessage key={m.id} m={m} ordinal={order.get(m.id) ?? 1} />;
                })}
                <div ref={tail} />
              </div>
            </div>
          )}

          {/* 详细编辑 + 拓展栏都开着时，这一块整个让出来,输入框搬进右边那块聊天面板 */}
          {!inPanel && composer}
        </div>

        {props.panel && (
          <ChatSidePanel
            messages={messages}
            detailOpen={detail}
            chatPanel={inPanel ? { composer, whyNot: vibe.whyNot ?? null, onBack: () => setDetail(false) } : null}
            onNote={setNote}
            onDetail={() => setDetail(true)}
            width={props.ext.width}
            onWidth={props.ext.onWidth}
            onWidthCommit={props.ext.onWidthCommit}
            onWidthNudge={props.ext.onWidthNudge}
          />
        )}
      </div>
      <CloudAgentConsentDialog open={vibe.consent.open} pending={vibe.consent.pending} error={vibe.consent.error}
        onAccept={vibe.consent.accept} onReject={vibe.consent.reject} />
    </main>
  );
}
