/**
 * Chat page: clicking a project Agent (Cloud Agent chat) in the sidebar comes here (UI shape: user
 * decision, 2026-10-23).
 *
 * The shape follows the chats in a mobile app: messages in the middle, a bottom-pinned input box below.
 * Your own messages go on the right in accent-color bubbles; Agent messages go on the left in
 * panel-color bubbles, with a sparkle avatar in front: consistent with the editor's right rail
 * (`src/editor/right/chat/MessageList.tsx`).
 *
 * 2026-10-23: connected to the business layer (`docs/reports/AGENT-claude-vibe-wire.md`): messages, send
 * and stop are all real, and the data and actions are supplied by the caller per `VibeAgent` in
 * `vibeAgent.ts`: the online browser uses the Cloud Agent (`useVibeCloud.ts`), and the desktop app uses
 * the local CLI / API Agent (`useVibeLocal.ts`, the same set as the editor's AI panel). This page treats
 * both alike and does not care which one it is.
 *   - A round of reply is split per "Report" in `product/agent.md`: the bubble holds only what the Agent
 *     says about "what it is doing", and the operations done are listed in the "Agent actions" block
 *     (the split is shared with the mobile app via `roundView` in `src/mobile/agentView.ts`);
 *   - Before the cloud has accepted your own message, its sending status is shown, and if it was not
 *     sent the reason is shown; in a shared chat, messages sent by others are labeled with who sent them;
 *   - When the chat is empty there is only one example sentence (`workflow/production.md`, "User sends an
 *     instruction"); click it to fill it into the input box;
 *   - When sending is impossible (read-only member, the creator viewing someone else's private chat, the
 *     switch is off) the input box is greyed out and the line below says why.
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
import { tr } from "../i18n/index.ts";

/** Before the sentence from the start page is sent automatically, how much longer to wait after the selection connects (milliseconds): leaves margin for the document service to register this page */
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
        {m.sendState === "sending" && <span className="ps-msg-state">{tr("Sending…")}</span>}
        {m.sendState === "accepted" && <span className="ps-msg-state">{tr("Sent, waiting for the cloud to start processing…")}</span>}
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
            <div className="ps-actions-head">{tr("Agent action · {0}", v.title)}</div>
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
        {!live && !sayings.length && !v.hasCard && !m.error && !outcome && <p className="ps-msg-text ps-msg-live">{tr("(no text was left for this turn)")}</p>}
        {m.error && <p className="ps-msg-text ps-msg-err" role="alert" data-pc="start-chat-error">{m.error}</p>}
        {outcome && <p className="ps-msg-text ps-msg-live">{outcome}</p>}
        {m.cloudRender && <p className={`ps-msg-text ps-msg-live${m.cloudRender.state === "failed" || m.cloudRender.state === "unavailable" ? " ps-msg-err" : ""}`}>{m.cloudRender.text}</p>}
      </div>
    </div>
  );
}

export function ChatView(props: {
  vibe: VibeAgent;
  /** Chat title (the line on the top bar); the input box placeholder here needs it */
  title: string;
  /** The sentence said on the start page: sent out automatically once on entering the chat page (cleared by the parent once sent) */
  pending: string | null;
  onPendingSent: () => void;
  /** Whether the side panel on the right is open. The toggle is on the top bar (`TopBar.tsx`), so the state is held in `OnlineStart` */
  panel: boolean;
  /** Switch to Classic mode (opens the editor); the button is on the head of "Detail editing" */
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
  /** The note raised from the side panel or detail editing, shown under the input box */
  const [note, setNote] = useState("");
  const [detail, setDetail] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  const convId = vibe.chat.conversationId;

  // Switching to another chat: an unsent draft is not carried over. The sentence brought from the start page is first put into the input box (visible) and sent automatically when ready;
  // if it could not be sent (rejected with a notice), it stays in the input box and does not need retyping
  useEffect(() => {
    setText(props.pending ?? "");
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);
  useEffect(() => { if (props.pending) setText(props.pending); }, [props.pending]);
  useEffect(() => { tail.current?.scrollIntoView({ block: "end" }); }, [messages]);

  /*
   * Where the input box is right now (user decision, 2026-10-26, issue #4): when detail editing is
   * expanded and the side panel is also open, it is at the bottom of the chat panel in the side panel;
   * in the other three combinations it is at the bottom of the chat column.
   *
   * So when the user collapses the side panel themselves (the rightmost button on the top bar,
   * `start-chat-ext-toggle`), the input box drops back to the bottom of the chat column and detail editing
   * stays open: the two switches each do their own job, and every combination has somewhere to talk.
   * What issue #4 objected to was "it sits right under the timeline by default", not that this position
   * can never be used.
   *
   * Both places share the same `text`, so the draft follows by itself; the textarea remounts when it moves,
   * and focus is restored here.
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
    // Not sent (not yet confirmed, rejected): put the original text back into the input box so the user does not retype it
    if (!ok) setText((cur) => cur || t);
  };

  // The sentence said on the start page: send it once when the chat is ready (able to send)
  // It must also wait until this page's selection is registered on the document service side: in account mode a sent message carries a snapshot of this page's selection, and right after entering a project the document service does not yet have this page,
  // so sending immediately would be rejected (`selection-page-unavailable`). A manual send never hits this (people type slower than that), but this auto-sent one waits a little after the selection connects
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
    // The cloud execution service is not taking jobs: same sentence as the editor's right rail (cloud-note in `CloudAiPanel.tsx`). The local Agent has no execution service, always false
    || (vibe.waitingExecutor ? tr("Messages are queued persistently while waiting for the executor service; reopen to pick up where you left off.") : "")

    || (vibe.queued > 0 ? tr("{0} more ahead in the queue, running one turn at a time.", vibe.queued) : "")
    || vibe.hint;

  // The same input box, two placements: either at the bottom of the chat column, or in the panel in the side panel (see `inPanel` above)
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
      placeholder={vibe.canSend ? tr("Say something to \"{0}\"", props.title) : (vibe.whyNot ?? "")}
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
                setNote(tr("Put \"{0}\" into the input box.", q));
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
                      <p className="ps-muted">{vibe.whyNot ?? tr("Connecting to the Cloud Agent…")}</p>
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

          {/* When detail editing + the side panel are both open, this whole block yields, and the input box moves into the chat panel on the right */}
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
