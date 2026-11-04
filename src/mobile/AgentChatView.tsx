/**
 * How the chat page of one session in the mobile app's Agent tab is rendered (the Agent page of the demo mockup `prototypes/mobile-ui-demo/`): creativity row, message area, input area.
 * It only handles rendering and the message area's stick-to-bottom following; data and actions come from `AgentChat.tsx` (cloud chat, notice confirmation, permissions, sending), so a probe can also render a page straight from fake messages without a cloud connection (`agent-harness.tsx`).
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
import { tr } from "../i18n/index.ts";

/** The row of quick questions above the demo mockup's input box: tap one to put the sentence into the input box (not sent directly) */
export const QUICKS: readonly (readonly [string, string])[] = [
  [tr("Grander title"), tr("Make the opening title more grand")],
  [tr("Add transition"), tr("Add a transition to the second clip")],
  [tr("Background music"), tr("Add some relaxed background music")],
  [tr("Cut faster"), tr("Make the overall pacing faster")],
];

export const PLACEHOLDER = tr("Tell the Agent what you want to change…");

export interface AgentChatViewProps {
  tabId: string;
  /** Whether this page is the one the user is looking at right now */
  shown: boolean;
  /** Small text on an Agent bubble (the name of the session tab) */
  who: string;
  messages: readonly ChatMessage[];
  /** Start page (this project has no session at all) */
  start: { draft: boolean; animated: boolean; guide: StartGuide; onPickPreset: () => void };
  level: CreativityLevel;
  levelDisabled: boolean;
  onLevel: (lv: CreativityLevel) => void;
  /** Small "shared chat / private chat" label; an empty string renders nothing */
  visLabel: string;
  canToggleVisibility: boolean;
  onToggleVisibility: () => void;
  /** Notice bar below the creativity row (hosted side has no Agent, disabled, reconnecting, page notices) */
  banners?: ReactNode;
  /** Number of queued messages in the chat */
  queued: number;
  /** Creator is read-only: the input area is not rendered */
  readOnly: boolean;
  quotes: readonly QuoteRef[];
  onRemoveQuote: (id: string) => void;
  inputText: string;
  onInput: (v: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  inputDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
  /** Running and the input box is empty: the send button turns into stop */
  stopMode: boolean;
  onPickExample: (text: string) => void;
  /** Things pinned at the very top of this page (the notice confirmation dialog) */
  dialog?: ReactNode;
}

export function AgentChatView(p: AgentChatViewProps) {
  const { messages } = p;
  // This project only grants read-only permission (guest): chat history is read as usual, but messages cannot be sent; the input area is replaced by a one-line note
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
  // The user just sent one: stick to the bottom and follow; normally follow only when already at the bottom, and do not yank when scrolled up to read
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
  const placeholder = p.quotes.length ? tr("What would you like to change about @{0}?", p.quotes[0].label) : PLACEHOLDER;
  const empty = !p.start.draft && messages.length === 0;

  return (
    <div className="achat" data-pcm="agent-chat" data-tab={p.tabId} data-shown={p.shown ? "1" : "0"} style={p.shown ? undefined : { display: "none" }}>
      {p.dialog}
      <div className="chat-info" data-pcm="chat-info">
        <span>{tr("Creativity")}</span>
        <div className="level" data-pcm="creativity">
          {CREATIVITY_LEVELS.map((lv: CreativityLevel) => (
            <button key={lv} type="button" className={lv === p.level ? "on" : undefined} data-l={tr(CREATIVITY_LABEL[lv])} disabled={p.levelDisabled || ro.locked}
              title={`${tr(CREATIVITY_LABEL[lv])}:${tr(CREATIVITY_HINT[lv])}`} onClick={() => p.onLevel(lv)}>{tr(CREATIVITY_LABEL[lv])}</button>
          ))}
        </div>
        <span className="spacer" />
        {p.visLabel && (p.canToggleVisibility
          ? <button type="button" className="chip" data-pcm="vis-chip" title={tr("Tap to switch between shared / private")} onClick={p.onToggleVisibility}>{p.visLabel}</button>
          : <span className="chip" data-pcm="vis-chip">{p.visLabel}</span>)}
      </div>

      {p.banners}

      <div className="msgs" ref={listRef} onScroll={onScroll} data-pcm="chat-msgs">
        {p.start.draft ? (
          <StartHero animated={p.start.animated} onPickPreset={p.start.onPickPreset} />
        ) : empty ? (
          <div className="empty" data-pcm="agent-empty">
            <div className="hint">{tr("This is a new chat. What would you like me to do?")}</div>
            <button type="button" className="preset" data-pcm="agent-empty-example" disabled={ro.locked} title={ro.title()} onClick={() => p.onPickExample(EMPTY_EXAMPLE)}>{EMPTY_EXAMPLE}</button>
          </div>
        ) : messages.map((m) => (isUserBubble(m)
          ? <UserBubble key={m.id} m={m} />
          : m.role === "assistant" ? <AgentRound key={m.id} m={m} ordinal={rounds.get(m.id) ?? 1} open={m.id === latestAssistant} who={p.who} /> : null))}
        {p.queued > 0 && <div className="queue-note" data-pcm="queue-note">{tr("{0} messages are queued; yours runs when the ones ahead finish", p.queued)}</div>}
      </div>

      {p.readOnly || ro.locked ? (
        <div className="composer" data-pcm="agent-composer" data-readonly={ro.locked ? "1" : undefined}><div className="note">{p.readOnly ? tr("The project creator can view this private chat but can't send messages.") : ro.why}</div></div>
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
              aria-label={tr("Tell the Agent what you want to change")}
              onChange={(e) => p.onInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); p.onSend(); } }} />
            <button type="button" className={`send${p.stopMode ? " is-stop" : ""}`} data-pcm={p.stopMode ? "chat-stop" : "chat-send"} aria-label={p.stopMode ? tr("Stop") : tr("Send")} data-has-text={hasText ? "1" : "0"}
              onClick={() => (p.stopMode ? p.onStop() : p.onSend())}><Icon name={p.stopMode ? "stop" : "send"} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
