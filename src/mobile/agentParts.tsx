/**
 * 手机版 Agent 分页的画法小件(演示稿 `prototypes/mobile-ui-demo/index.html` 的 Agent 页:消息气泡、操作卡片、引用标记条、开始页)。
 * 只管画,数据与动作由 `AgentChat.tsx` 给;怎么把一轮回复拆成气泡和卡片见 `agentView.ts`。
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

/** 引用标记:气泡上是只读的小标签,输入框上方的标记条里带「✕」 */
export function RefChip(props: { label: string; onRemove?: () => void }) {
  return (
    <span className="ref" data-pcm={props.onRemove ? "ref-chip" : "ref-tag"}>
      @ {props.label}
      {props.onRemove && <b role="button" aria-label={`去掉引用 ${props.label}`} data-pcm="ref-remove" onClick={props.onRemove}>✕</b>}
    </span>
  );
}

/** 输入框上方的引用标记条:点「引用」之后出现,发送后清空 */
export function QuoteBar(props: { quotes: readonly QuoteRef[]; onRemove: (id: string) => void }) {
  if (!props.quotes.length) return null;
  return (
    <div className="refbar" data-pcm="refbar">
      {props.quotes.map((q) => <RefChip key={q.id} label={q.label} onRemove={() => props.onRemove(q.id)} />)}
    </div>
  );
}

/** 我发的话:靠右的青蓝气泡;开头的引用画成标记;云端还没收下之前写明发送状态 */
export const UserBubble = memo(function UserBubble({ m }: { m: ChatMessage }) {
  const { quotes, rest } = splitQuotes(m.text);
  const failed = m.sendState === "failed";
  return (
    <div className={`msg me${m.sendState === "sending" || m.sendState === "queued" ? " is-sending" : failed ? " is-failed" : ""}`} data-pcm="msg-me">
      {quotes.length > 0 && (
        <div className="refs">{quotes.map((q) => <RefChip key={q.id} label={q.label} />)}</div>
      )}
      {rest ? <div className="plain">{rest}</div> : null}
      {m.sendState === "sending" && <div className="send-state">发送中…</div>}
      {m.sendState === "accepted" && <div className="send-state">已发出,等待云端开始处理…</div>}
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

/** 操作卡片:一轮的所有操作,折叠;最新一轮或还在跑的默认展开 */
function OpsCard(props: { title: string; items: OpItem[]; reports: { title: string; rows: ReportRow[] }[]; open: boolean }) {
  const [open, setOpen] = useState(props.open);
  return (
    <details className="ops" open={open} data-pcm="ops-card" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><span className="chip plum">Agent 操作</span> {props.title}</summary>
      <div className="items">
        {props.items.map((it) => <OpRow key={it.key} state={it.state}><b>{it.kind}</b> {it.name}</OpRow>)}
        {props.reports.map((r, i) => (
          <div className="rep" key={i}>
            <div className="rep-title">{r.title}</div>
            {r.rows.length === 0 && <div className="param-diff">(没有可汇报的内容)</div>}
            {r.rows.map((row, j) => <OpRow key={j} state={row.state}>{row.text}</OpRow>)}
          </div>
        ))}
      </div>
    </details>
  );
}

/** 一轮 Agent 回复:动手之前说的话 → 操作卡片 → 动手之后说的话;还在跑时末尾一个「正在做什么」 */
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

/** 开始页(没有会话时):一句话说明 + 预设按钮;刚进项目、没被手动清空过时带引导动画(光点、指向输入框的箭头) */
export function StartHero(props: { animated: boolean; onPickPreset: () => void }) {
  // 这个项目只给了只读权限(游客):不能给 Agent 发话,不放引导动画和预设,只说明为什么
  const ro = useReadOnly();
  const { onPickPreset } = props;
  const animated = props.animated && !ro.locked;
  if (ro.locked) {
    return (
      <div className="start" data-pcm="agent-start" data-animated="0" data-readonly="1">
        <div className="start-title">只能查看</div>
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
      <div className="start-title">{animated ? "从这里开始" : "开始"}</div>
      <div className="start-hint">{animated ? "在下面的输入框里写下你想做的片子,或者点这一句:" : "在下面的输入框里写下你想做的,或者点这一句:"}</div>
      <button type="button" className="preset" data-pcm="agent-start-preset" onClick={onPickPreset}>{START_PRESET}</button>
      {animated && <div className="cue" data-pcm="agent-start-cue" aria-hidden="true">⌄</div>}
    </div>
  );
}

/** 对话标签行:每个会话一个标签(Agent 1、Agent 2……,都带 ✕),没有会话时只有一项「开始」;右边「+」新开 */
export interface TabItem { id: string; title: string; draft?: boolean; busy?: boolean }
export function AgentTabsBar(props: { tabs: readonly TabItem[]; activeId: string; onActivate: (id: string) => void; onClose: (id: string, title: string) => void; onNew: () => void }) {
  return (
    <div className="chat-top" data-pcm="chat-top">
      <div className="atabs" data-pcm="atabs">
        {props.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === props.activeId} className={`atab${t.id === props.activeId ? " on" : ""}`} data-pcm="atab" data-draft={t.draft ? "1" : undefined}
            onClick={() => props.onActivate(t.id)}>
            {t.busy && <i className="dot run" aria-hidden="true" />}
            <span className="nm">{t.draft ? "开始" : t.title}</span>
            {t.draft
              ? <span className="x-gap" />
              : <span className="x" role="button" aria-label={`关闭 ${t.title}`} data-pcm="atab-close" onClick={(e) => { e.stopPropagation(); props.onClose(t.id, t.title); }}>✕</span>}
          </div>
        ))}
      </div>
      <button type="button" className="icon-btn" data-pcm="atab-new" title="新对话" aria-label="新对话" onClick={props.onNew}><Icon name="plus" /></button>
    </div>
  );
}
