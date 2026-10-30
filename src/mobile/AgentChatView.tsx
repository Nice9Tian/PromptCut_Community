/**
 * 手机版 Agent 分页里一个会话的对话页的画法(演示稿 `prototypes/mobile-ui-demo/` 的 Agent 页):创造力一行、消息区、输入区。
 * 只管画与消息区的贴底跟随;数据与动作由 `AgentChat.tsx` 给(云端对话、告知确认、权限、发送),这样探针也能不接云端、直接用假消息画一页(`agent-harness.tsx`)。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { ChatMessage } from "../ai/types";
import type { CreativityLevel } from "../kernel/creativity.mjs";
import { CREATIVITY_HINT, CREATIVITY_LABEL, CREATIVITY_LEVELS } from "../kernel/creativity.mjs";
import type { StartGuide } from "../editor/right/chat/StartHero";
import { EMPTY_EXAMPLE } from "../editor/right/chat/MessageList";
import { Icon } from "./icons";
import { useReadOnly } from "../editor/readOnly";
import { AgentRound, QuoteBar, StartHero, UserBubble } from "./agentParts";
import { isUserBubble, ordinals, type QuoteRef } from "./agentView";

/** 演示稿输入框上方那排快捷提问:点一下把这句话放进输入框(不直接发送) */
export const QUICKS: readonly (readonly [string, string])[] = [
  ["标题更大气", "把开头的标题做得更大气一点"],
  ["加转场", "给第二段加一个转场"],
  ["配乐", "配一段轻松的背景音乐"],
  ["剪快点", "把整体节奏剪快一点"],
];

export const PLACEHOLDER = "告诉 Agent 你想怎么改…";

export interface AgentChatViewProps {
  tabId: string;
  /** 这一页此刻是不是用户看着的那一页 */
  shown: boolean;
  /** Agent 气泡上的小字(会话标签的名字) */
  who: string;
  messages: readonly ChatMessage[];
  /** 开始页(本项目一个会话都没有) */
  start: { draft: boolean; animated: boolean; guide: StartGuide; onPickPreset: () => void };
  level: CreativityLevel;
  levelDisabled: boolean;
  onLevel: (lv: CreativityLevel) => void;
  /** 「共有对话 / 私有对话」小标签;空串不画 */
  visLabel: string;
  canToggleVisibility: boolean;
  onToggleVisibility: () => void;
  /** 创造力一行下面的提示条(托管端没有 Agent、被关、重连中、页面提示) */
  banners?: ReactNode;
  /** 对话里在排队的消息数 */
  queued: number;
  /** 创建者只读:不画输入区 */
  readOnly: boolean;
  quotes: readonly QuoteRef[];
  onRemoveQuote: (id: string) => void;
  inputText: string;
  onInput: (v: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  inputDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
  /** 在跑、输入框又是空的:发送钮换成停止 */
  stopMode: boolean;
  onPickExample: (text: string) => void;
  /** 挂在这页最上面的东西(告知确认框) */
  dialog?: ReactNode;
}

export function AgentChatView(p: AgentChatViewProps) {
  const { messages } = p;
  // 这个项目只给了只读权限(游客):对话历史照常读,但不能发消息;输入区换成一句说明
  const ro = useReadOnly();
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const rounds = useMemo(() => ordinals(messages), [messages]);
  const latestAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i].id;
    return null;
  }, [messages]);
  // 用户刚发了一条:贴底跟着看;平时只有本来就在底部时才跟,往上翻着看就不拽
  const last = messages[messages.length - 1];
  const lastMine = last?.role === "user" ? last.id : null;
  useEffect(() => { if (lastMine) stick.current = true; }, [lastMine]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && p.shown && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    if (!p.shown) return;
    stick.current = true;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.shown]);

  const hasText = p.inputText.trim().length > 0;
  const placeholder = p.quotes.length ? `@${p.quotes[0].label} 想怎么改?` : PLACEHOLDER;
  const empty = !p.start.draft && messages.length === 0;

  return (
    <div className="achat" data-pcm="agent-chat" data-tab={p.tabId} data-shown={p.shown ? "1" : "0"} style={p.shown ? undefined : { display: "none" }}>
      {p.dialog}
      <div className="chat-info" data-pcm="chat-info">
        <span>创造力</span>
        <div className="level" data-pcm="creativity">
          {CREATIVITY_LEVELS.map((lv: CreativityLevel) => (
            <button key={lv} type="button" className={lv === p.level ? "on" : undefined} data-l={CREATIVITY_LABEL[lv]} disabled={p.levelDisabled || ro.locked}
              title={`${CREATIVITY_LABEL[lv]}:${CREATIVITY_HINT[lv]}`} onClick={() => p.onLevel(lv)}>{CREATIVITY_LABEL[lv]}</button>
          ))}
        </div>
        <span className="spacer" />
        {p.visLabel && (p.canToggleVisibility
          ? <button type="button" className="chip" data-pcm="vis-chip" title="点一下切换共有 / 私有" onClick={p.onToggleVisibility}>{p.visLabel}</button>
          : <span className="chip" data-pcm="vis-chip">{p.visLabel}</span>)}
      </div>

      {p.banners}

      <div className="msgs" ref={listRef} onScroll={onScroll} data-pcm="chat-msgs">
        {p.start.draft ? (
          <StartHero animated={p.start.animated} onPickPreset={p.start.onPickPreset} />
        ) : empty ? (
          <div className="empty" data-pcm="agent-empty">
            <div className="hint">这是一个新对话。想让我做点什么?</div>
            <button type="button" className="preset" data-pcm="agent-empty-example" disabled={ro.locked} title={ro.title()} onClick={() => p.onPickExample(EMPTY_EXAMPLE)}>{EMPTY_EXAMPLE}</button>
          </div>
        ) : messages.map((m) => (isUserBubble(m)
          ? <UserBubble key={m.id} m={m} />
          : m.role === "assistant" ? <AgentRound key={m.id} m={m} ordinal={rounds.get(m.id) ?? 1} open={m.id === latestAssistant} who={p.who} /> : null))}
        {p.queued > 0 && <div className="queue-note" data-pcm="queue-note">有 {p.queued} 条消息在排队,前面的做完就轮到</div>}
      </div>

      {p.readOnly || ro.locked ? (
        <div className="composer" data-pcm="agent-composer" data-readonly={ro.locked ? "1" : undefined}><div className="note">{p.readOnly ? "项目创建者可以查看这段私有对话,但不能发送消息。" : ro.why}</div></div>
      ) : (
        <div className="composer" data-pcm="agent-composer" data-guide={p.start.guide ?? undefined}>
          <QuoteBar quotes={p.quotes} onRemove={p.onRemoveQuote} />
          {!p.start.draft && (
            <div className="quicks" data-pcm="quicks">
              {QUICKS.map(([label, sentence]) => <button key={label} type="button" onClick={() => p.onPickExample(sentence)}>{label}</button>)}
            </div>
          )}
          <div className="in-row">
            <textarea ref={p.inputRef} rows={1} data-pcm="chat-input" value={p.inputText} placeholder={placeholder} disabled={p.inputDisabled}
              aria-label="告诉 Agent 你想怎么改"
              onChange={(e) => p.onInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); p.onSend(); } }} />
            <button type="button" className={`send${p.stopMode ? " is-stop" : ""}`} data-pcm={p.stopMode ? "chat-stop" : "chat-send"} aria-label={p.stopMode ? "停止" : "发送"} data-has-text={hasText ? "1" : "0"}
              onClick={() => (p.stopMode ? p.onStop() : p.onSend())}><Icon name={p.stopMode ? "stop" : "send"} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
