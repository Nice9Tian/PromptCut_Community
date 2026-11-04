/**
 * The chat panel in the side panel (user decision, 2026-10-26; issue #4).
 *
 * As soon as "Detail editing" expands, the timeline editing area fills the whole chat area (input box
 * included) and the chat moves here: yet another standalone card alongside "Picture" and
 * "Before / after", with a short entrance animation (`ps-ext-chat-in` of `.ps-ext-chat`).
 * It takes whatever height the side panel has left, and the two sections above spread out as usual
 * (user decision, 2026-10-26: option "Jia" chosen out of two).
 *
 * **It is narrow, so older content is collapsed** (issue #4, verbatim: "once two sentences are reached,
 * truncate to '...'. Keep only the latest Agent reply"):
 *   - only **the latest Agent reply** keeps its full text;
 *   - the other Agent replies and **all** user bubbles collapse to two lines, and this round's "Agent
 *     operations" are folded as well, with a line saying "N more operations";
 *   - the clickable look is shown only when text is really truncated: a short sentence that fits on one
 *     line does not get it ("click to see full text" is measured, not guessed, because this panel can be
 *     dragged wider or narrower and guessing by character count would be wrong);
 *   - clicking any collapsed bubble expands that one alone to full text; when detail editing is entered
 *     again this panel is remounted, and anything that was expanded collapses again.
 *
 * Bubbles use their own set of class names (`ps-x…`, x = the one in the side panel) and do not mix with
 * `.ps-msg` of the chat column: that one is a 760px-wide reading layout, while this one is 250px at the
 * narrowest (`EXT_WIDTH.min` in `sideWidth.ts`), with font size, padding and avatar all one size smaller.
 * How a round of reply is split into "what was said + operations" is shared by both sides through
 * `roundView` in `src/mobile/agentView.ts`; no second copy is written.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { ChatMessage } from "../ai/types";
import { activityText, runningTool } from "../editor/right/chat/AgentBubble";
import { isUserBubble, ordinals, partsOf, roundView, splitQuotes } from "../mobile/agentView";
import { tr } from "../i18n/index.ts";

const MARK: Record<string, string> = { done: "✓", run: "…", todo: "·", err: "!", ask: "!" };

/**
 * A bubble frame that can collapse. When collapsed, CSS truncates the text to two lines (`[data-folded]`);
 * this only handles: measuring whether it was really truncated, how many hidden actions there are, and
 * expanding on click.
 */
function Foldable(props: {
  className: string;
  folded: boolean;
  /** Number of actions hidden after collapsing */
  hiddenOps: number;
  onExpand: () => void;
  /** Fingerprint of the content: re-measure when it changes */
  mark: string;
  children: ReactNode;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const p = box.current?.querySelector<HTMLElement>(".ps-xtext");
    if (!p || !props.folded) {
      setClipped(false);
      return;
    }
    const check = () => setClipped(p.scrollHeight - p.clientHeight > 2);
    check();
    // This panel can be dragged wider or narrower, and once the width changes, whether it truncates changes too
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(p);
    return () => ro.disconnect();
  }, [props.folded, props.mark]);

  // Only when collapsed and **really** something is not shown does it look clickable --- a short sentence that fits on one line does not (CSS looks at `data-more`)
  const more = props.folded && (clipped || props.hiddenOps > 0);
  return (
    <div
      ref={box}
      className={props.className}
      data-folded={props.folded || undefined}
      data-more={more || undefined}
      title={more ? tr("Click to see the full text") : undefined}
      onClick={more ? props.onExpand : undefined}
    >
      {props.children}
      {more && props.hiddenOps > 0 && (
        <span className="ps-xmore">{tr("… {0} more actions", props.hiddenOps)}</span>
      )}
    </div>
  );
}

function PanelUserMessage(props: { m: ChatMessage; folded: boolean; onExpand: () => void }): JSX.Element {
  const { quotes, rest } = splitQuotes(props.m.text);
  const body = `${quotes.map((q) => `@${q.label} `).join("")}${rest}`;
  return (
    <div className="ps-xmsg is-me" data-pc="start-ext-chat-msg" data-from="me">
      <Foldable className="ps-xbubble" folded={props.folded} hiddenOps={0} onExpand={props.onExpand} mark={body}>
        <p className="ps-xtext">{body}</p>
      </Foldable>
    </div>
  );
}

function PanelAgentMessage(props: { m: ChatMessage; ordinal: number; folded: boolean; onExpand: () => void }): JSX.Element {
  const { m } = props;
  const v = roundView(m, props.ordinal);
  const live = !!m.pending;
  const text = [...v.before, ...v.after].map((s) => s.text).join("\n");
  const ops = v.items;

  return (
    <div className="ps-xmsg is-agent" data-pc="start-ext-chat-msg" data-from="agent" data-live={live || undefined}>
      <span className="ps-xavatar" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.8c.5 4.3 2.1 6.1 6.4 6.6-4.3.5-5.9 2.3-6.4 6.6-.5-4.3-2.1-6.1-6.4-6.6 4.3-.5 5.9-2.3 6.4-6.6Z" />
        </svg>
      </span>
      <Foldable className="ps-xbody" folded={props.folded} hiddenOps={ops.length} onExpand={props.onExpand} mark={text}>
        <p className="ps-xtext">{text || (live ? "" : tr("(No text was left from this turn)"))}</p>
        {ops.length > 0 && (
          <div className="ps-xops">
            <div className="ps-xops-head">{tr("Agent actions")}</div>
            <ul className="ps-xops-list">
              {ops.map((it) => (
                <li key={it.key} data-state={it.state}><span className="ps-op-mark">{MARK[it.state]}</span>{it.kind} · {it.name}</li>
              ))}
            </ul>
          </div>
        )}
        {live && <p className="ps-xlive" data-pc="start-ext-chat-typing">{activityText(m, runningTool(partsOf(m)))}</p>}
        {m.error && <p className="ps-xlive is-err" role="alert">{m.error}</p>}
      </Foldable>
    </div>
  );
}

export function ExtChatPanel(props: {
  messages: readonly ChatMessage[];
  /** Input box. The same React state as the one at the bottom of the chat column (`Composer.tsx`); moving it over does not lose the draft */
  composer: JSX.Element;
  /** "Back to full page": collapse detail editing and put the chat back in the big middle area */
  onBack: () => void;
  /** Explanation shown when messages can't be sent; displayed while there are no messages */
  whyNot: string | null;
}): JSX.Element {
  /** The ones the user opened by hand, keyed by message id */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const tail = useRef<HTMLDivElement>(null);

  const shown = props.messages.filter((m) => m.role === "assistant" || isUserBubble(m));
  const order = ordinals(props.messages);
  // "Keep only the latest Agent reply": that one is shown in full
  let keep: string | null = null;
  for (let i = shown.length - 1; i >= 0; i--) {
    if (shown[i].role === "assistant") { keep = shown[i].id; break; }
  }

  useLayoutEffect(() => { tail.current?.scrollIntoView({ block: "end" }); }, [props.messages]);

  const expand = (id: string) => setExpanded((s) => new Set(s).add(id));

  return (
    <section className="ps-ext-chat" data-pc="start-ext-chat">
      <div className="ps-ext-chat-head">
        <span className="ps-ext-chat-title">{tr("Chat")}</span>
        <span className="ps-rail-spacer" />
        <button type="button" className="ps-ext-action" data-pc="start-ext-chat-back"
          title={tr("Collapse detail editing and return the chat to the large middle area")} onClick={props.onBack}>
          {tr("Back to full page")}
        </button>
      </div>

      <div className="ps-ext-chat-list" data-pc="start-ext-chat-list">
        {shown.length === 0 && (
          <p className="ps-ext-todo" data-pc="start-ext-chat-empty">
            {props.whyNot ?? tr("This chat has no messages yet, say something below.")}
          </p>
        )}
        {shown.map((m) => {
          const folded = m.id !== keep && !expanded.has(m.id);
          if (m.role === "assistant" && m.id === keep && shown.length > 1) {
            return (
              <div key={m.id}>
                <div className="ps-xlatest">{tr("Latest reply")}</div>
                <PanelAgentMessage m={m} ordinal={order.get(m.id) ?? 1} folded={false} onExpand={() => expand(m.id)} />
              </div>
            );
          }
          return m.role === "user"
            ? <PanelUserMessage key={m.id} m={m} folded={folded} onExpand={() => expand(m.id)} />
            : <PanelAgentMessage key={m.id} m={m} ordinal={order.get(m.id) ?? 1} folded={folded} onExpand={() => expand(m.id)} />;
        })}
        <div ref={tail} />
      </div>

      {props.composer}
    </section>
  );
}
