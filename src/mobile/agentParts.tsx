/**
 * Drawing widgets of the mobile app Agent tab (the Agent page of the demo
 * `prototypes/mobile-ui-demo/index.html`: message bubbles, action cards, quote bar, start page).
 * Drawing only; data and actions are supplied by `AgentChat.tsx`; for how a round of replies is split
 * into bubbles and cards see `agentView.ts`.
 */
import { memo, useState } from "react";
import { LiveMarkdown } from "../ai/Markdown";
import type { ChatMessage } from "../ai/types";
import { OUTBOX_RESEND_EVENT, OUTBOX_TEXT } from "../ai/outbox";
import { START_PRESET } from "../editor/right/chat/StartHero";
import { useReadOnly } from "../editor/readOnly";
import { activityText, outcomeText, partsOf, runningTool } from "../editor/right/chat/AgentBubble";
import { Icon } from "./icons";
import { roundView, splitQuotes, type OpItem, type QuoteRef, type ReportRow } from "./agentView";
import { tr } from "../i18n/index.ts";

/** Quote marker: a read-only small tag on a bubble, with a "✕" in the quote bar above the input box */
export function RefChip(props: { label: string; onRemove?: () => void }) {
  return (
    <span className="ref" data-pcm={props.onRemove ? "ref-chip" : "ref-tag"}>
      @ {props.label}
      {props.onRemove && <b role="button" aria-label={tr("Remove reference {0}", props.label)} data-pcm="ref-remove" onClick={props.onRemove}>✕</b>}
    </span>
  );
}

/** Quote bar above the input box: appears after tapping "Quote", cleared after sending */
export function QuoteBar(props: { quotes: readonly QuoteRef[]; onRemove: (id: string) => void }) {
  if (!props.quotes.length) return null;
  return (
    <div className="refbar" data-pcm="refbar">
      {props.quotes.map((q) => <RefChip key={q.id} label={q.label} onRemove={() => props.onRemove(q.id)} />)}
    </div>
  );
}

/** A message I sent: a cyan-blue bubble on the right; leading quotes are drawn as markers; the sending status is shown until the cloud has received it */
export const UserBubble = memo(function UserBubble({ m }: { m: ChatMessage }) {
  const { quotes, rest } = splitQuotes(m.text);
  const failed = m.sendState === "failed";
  return (
    <div className={`msg me${m.sendState === "sending" || m.sendState === "queued" ? " is-sending" : failed ? " is-failed" : ""}`} data-pcm="msg-me">
      {quotes.length > 0 && (
        <div className="refs">{quotes.map((q) => <RefChip key={q.id} label={q.label} />)}</div>
      )}
      {rest ? <div className="plain">{rest}</div> : null}
      {m.sendState === "sending" && <div className="send-state">{tr("Sending…")}</div>}
      {m.sendState === "accepted" && <div className="send-state">{tr("Sent, waiting for the cloud to start processing…")}</div>}
      {m.sendState === "queued" && <div className="send-state" data-pcm="send-queued">{OUTBOX_TEXT.queued}</div>}
      {m.error && <div className="send-err" data-pcm={failed ? "send-failed" : undefined}>{m.error}</div>}
      {failed && m.resendable && (
        <button type="button" className="resend" data-pcm="resend"
          onClick={() => window.dispatchEvent(new CustomEvent(OUTBOX_RESEND_EVENT, { detail: { id: m.id } }))}>
          {OUTBOX_TEXT.resend}
        </button>
      )}
    </div>
  );
});

function Dots() {
  return <span className="typing" aria-hidden="true"><i /><i /><i /></span>;
}

const MARK: Record<string, string> = { done: "✓", run: "…", todo: "", err: "!", ask: "!" };

function OpRow(props: { state: string; children: React.ReactNode }) {
  return <div className={`it ${props.state}`}><span className="mk">{MARK[props.state]}</span><span>{props.children}</span></div>;
}

/** Action card: all actions of one round, collapsed; the latest round or one still running is expanded by default */
function OpsCard(props: { title: string; items: OpItem[]; reports: { title: string; rows: ReportRow[] }[]; open: boolean }) {
  const [open, setOpen] = useState(props.open);
  return (
    <details className="ops" open={open} data-pcm="ops-card" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><span className="chip plum">{tr("Agent actions")}</span> {props.title}</summary>
      <div className="items">
        {props.items.map((it) => <OpRow key={it.key} state={it.state}><b>{it.kind}</b> {it.name}</OpRow>)}
        {props.reports.map((r, i) => (
          <div className="rep" key={i}>
            <div className="rep-title">{r.title}</div>
            {r.rows.length === 0 && <div className="param-diff">{tr("(nothing to report)")}</div>}
            {r.rows.map((row, j) => <OpRow key={j} state={row.state}>{row.text}</OpRow>)}
          </div>
        ))}
      </div>
    </details>
  );
}

/** One round of Agent reply: what it said before acting → action card → what it said after acting; while still running, a "what is it doing" line at the end */
export const AgentRound = memo(function AgentRound(props: { m: ChatMessage; ordinal: number; open: boolean; who: string }) {
  const { m, ordinal, open, who } = props;
  const v = roundView(m, ordinal);
  const live = !!m.pending;
  const lastText = [...v.before, ...v.after].filter((s) => s.from === "text").pop();
  const outcome = live ? null : outcomeText(m);
  const busyTool = live ? runningTool(partsOf(m)) : null;
  const say = (s: { key: string; text: string; from: string }) => (
    <div className="msg ag" data-pcm="msg-ag" key={s.key}>
      <div className="who">{who}</div>
      <div className="md"><LiveMarkdown text={s.text} live={live && s === lastText} /></div>
    </div>
  );
  return (
    <>
      {v.before.map(say)}
      {v.hasCard && <OpsCard title={v.title} items={v.items} reports={v.reports} open={open || live} />}
      {v.after.map(say)}
      {live && (
        <div className="msg ag" data-pcm="msg-typing">
          <Dots /><span className="act">{activityText(m, busyTool)}</span>
        </div>
      )}
      {m.error && <div className="msg ag err" data-pcm="msg-error" role="alert">{m.error}</div>}
      {outcome && <div className="msg ag note-out">{outcome}</div>}
      {m.cloudRender && (
        <div className={`msg ag note-out${m.cloudRender.state === "failed" || m.cloudRender.state === "unavailable" ? " err" : ""}`} data-pcm="msg-render">{m.cloudRender.text}</div>
      )}
    </>
  );
});

/** Start page (when there is no session): a one-line description + preset buttons; right after entering the project, if not cleared manually, it shows the guide animation (light dot, arrow pointing at the input box) */
export function StartHero(props: { animated: boolean; onPickPreset: () => void }) {
  // This project only has read-only permission (guest): cannot send messages to the Agent, so no guide animation and no presets, only an explanation of why
  const ro = useReadOnly();
  const { onPickPreset } = props;
  const animated = props.animated && !ro.locked;
  if (ro.locked) {
    return (
      <div className="start" data-pcm="agent-start" data-animated="0" data-readonly="1">
        <div className="start-title">{tr("View only")}</div>
        <div className="start-hint">{ro.why}</div>
        <button type="button" className="preset" data-pcm="agent-start-preset" disabled title={ro.why}>{START_PRESET}</button>
      </div>
    );
  }
  return (
    <div className={`start${animated ? " is-animated" : ""}`} data-pcm="agent-start" data-animated={animated ? "1" : "0"}>
      {animated && (
        <div className="orb" data-pcm="agent-start-orb" aria-hidden="true">
          <span className="ring" />
          <span className="ring ring2" />
          <span className="core"><Icon name="sparkle" /></span>
        </div>
      )}
      <div className="start-title">{animated ? tr("Start here") : tr("Start")}</div>
      <div className="start-hint">{animated ? tr("Write the video you want to make in the box below, or click this line:") : tr("Write what you want to make in the box below, or click this line:")}</div>
      <button type="button" className="preset" data-pcm="agent-start-preset" onClick={onPickPreset}>{START_PRESET}</button>
      {animated && <div className="cue" data-pcm="agent-start-cue" aria-hidden="true">⌄</div>}
    </div>
  );
}

/** Chat tab row: one tab per session (Agent 1, Agent 2..., all with ✕); with no session there is only one item, "Start"; "+" on the right opens a new one */
export interface TabItem { id: string; title: string; draft?: boolean; busy?: boolean }
export function AgentTabsBar(props: { tabs: readonly TabItem[]; activeId: string; onActivate: (id: string) => void; onClose: (id: string, title: string) => void; onNew: () => void }) {
  return (
    <div className="chat-top" data-pcm="chat-top">
      <div className="atabs" data-pcm="atabs">
        {props.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === props.activeId} className={`atab${t.id === props.activeId ? " on" : ""}`} data-pcm="atab" data-draft={t.draft ? "1" : undefined}
            onClick={() => props.onActivate(t.id)}>
            {t.busy && <i className="dot run" aria-hidden="true" />}
            <span className="nm">{t.draft ? tr("Start") : t.title}</span>
            {t.draft
              ? <span className="x-gap" />
              : <span className="x" role="button" aria-label={tr("Close {0}", t.title)} data-pcm="atab-close" onClick={(e) => { e.stopPropagation(); props.onClose(t.id, t.title); }}>✕</span>}
          </div>
        ))}
      </div>
      <button type="button" className="icon-btn" data-pcm="atab-new" title={tr("New chat")} aria-label={tr("New chat")} onClick={props.onNew}><Icon name="plus" /></button>
    </div>
  );
}
