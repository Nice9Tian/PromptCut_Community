import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { playEnter } from "../../enterMotion";
import type { ChatMessage, MessagePart, ToolCallInfo } from "../../../ai/types";
import { RoleName } from "../RoleAvatar";
import { LiveMarkdown } from "../../../ai/Markdown";
import { bareToolName } from "./iconRuns";
import { isReportTool, parseProgressReport, reportTitle, type ProgressReport } from "../../../ai/progressReport";
import { isUserMessageCall, sayingsOf } from "../../../ai/userMessages";
import "./agent.css";

/**
 * 取一条消息的有序片段。新消息自带 parts;旧会话历史里没有,
 * 就按「文字 → 状态 → 工具」的老顺序兜底,保证读得出来。
 */
export function partsOf(m: ChatMessage): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const s of m.statuses || []) legacy.push({ kind: "status", text: s });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

/**
 * 思考里那些步骤名,做成一条走马灯。
 *
 * 为什么不是纯文本:模型经中转站发回来的 `<think>` 里装的常常不是思维链,而是一句话的
 * 步骤名(「**Clarifying article link and scope**」)。原样铺在气泡里会把正文顶开,
 * 用户读一半被一段英文打断;藏进「显示思考」开关里又等于没有,他不知道它在忙什么。
 * 折中:只把步骤名抽出来排成一行行,最后一条在消息还没结束时带呼吸动画 ——
 * 一眼能看出「还在走、走到哪一步」,又不抢正文的位置。
 *
 * 现在只有详细模式还用它;简洁模式的「当前一步」挪到了输入框上方的 ThinkingStrip。
 */
export function StepStrip({ steps, live }: { steps: string[]; live: boolean }) {
  if (!steps.length) return null;
  return (
    <div className="ai-steps">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={i} className={"ai-step" + (live && last ? " is-live" : " is-done")}>
            <span className="ai-step-dot" />
            <span className="ai-step-label">{s}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 正在执行、还没有结果的那个工具(有就说明这一刻在跑它) */
export function runningTool(parts: MessagePart[]): ToolCallInfo | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool") return p.ok === undefined ? p : null;
  }
  return null;
}

/** 一条没跑完的消息:优先用内核报上来的进度,没有就退回「正在思考 / 正在执行 X」 */
export function activityText(m: ChatMessage, busyTool: ToolCallInfo | null): string {
  if (m.progress?.text) return m.progress.text;
  return busyTool ? `正在执行 ${bareToolName(busyTool.name)}` : "正在思考";
}

/**
 * 进度里的轮次和成败,单独放一行小字;没有轮次信息(CLI 驱动)就不显示。
 * `liveElapsedMs`:界面自己往前走的已用时间(见 LiveProgressMeta);不给就用进度里报的那个数。
 */
export function progressMeta(m: ChatMessage, liveElapsedMs?: number): string | null {
  const p = m.progress;
  if (!p?.round) return null;
  // maxRounds 为 null 是「不限轮次」(深度自主 + 自主轮次填 0):Infinity 过一趟 JSON 就是 null。
  // 写成「第 12/? 轮」会让人以为丢了信息,其实是本来就没有分母
  const bits = [p.maxRounds ? `第 ${p.round}/${p.maxRounds} 轮` : `第 ${p.round} 轮(不限)`];
  if (p.completed || p.failed) bits.push(`成功 ${p.completed ?? 0}·失败 ${p.failed ?? 0}`);
  const elapsed = liveElapsedMs ?? p.elapsedMs;
  if (elapsed) bits.push(`${Math.floor(elapsed / 1000)} 秒`);
  return bits.join(" · ");
}

/**
 * 轮次那行小字里的已用时间每秒往前走。进度只在换一步时才报一次(等模型回话的那一段可能好几十秒都没有新的),
 * 原来照抄进度里那个数,「第 1/24 轮 · 0 秒」就一直停在 0 秒(2026-10-19 在线实测)。
 * 以收到这条进度的时刻为起点,在它报的已用时间上往前加;换了一条进度就重新对齐;也按这一轮的开始时间算一份,取大的。跑完了就停表。
 */
export function LiveProgressMeta({ m }: { m: ChatMessage }) {
  const p = m.progress;
  const sig = p ? `${p.round}|${p.elapsedMs ?? 0}|${p.phase ?? ""}|${p.text ?? ""}` : "";
  const anchor = useRef<{ sig: string; elapsed: number; at: number } | null>(null);
  if (p && anchor.current?.sig !== sig) anchor.current = { sig, elapsed: p.elapsedMs ?? 0, at: Date.now() };
  const ticking = Boolean(m.pending && p?.round);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const now = Date.now();
  // 这一轮的开始时间(云端的 `run` 事件带的时刻)也算一份：重新打开页面时进度是重放来的，按收到时刻对齐会少算；
  // 两边取大的。开始时间离谱(比现在还晚、或超过一天，多半是两边时钟不准)就不用它
  const sinceStart = typeof m.startedAt === "number" && now >= m.startedAt && now - m.startedAt < 86_400_000 ? now - m.startedAt : 0;
  const live = ticking && anchor.current ? Math.max(anchor.current.elapsed + (now - anchor.current.at), sinceStart) : undefined;
  const text = progressMeta(m, live);
  return text ? <div className="ai-activity-meta" data-pc="activity-meta">{text}</div> : null;
}

/**
 * 跑完之后的结论。completed 不显示(正常结束不用多说一句),
 * 其余几种都要让用户看见:停下来的原因不同,该做的事也不同。
 * 用户自己停的只写「已停止」:是他按的,不用解释。
 */
export const OUTCOME_TEXT: Record<string, string> = {
  stalled: "检测到重复操作没有进展,已停下来。上面的总结说明了做到哪一步。",
  round_limit: "已达到本次模型往返轮数上限。已完成的修改保留,可以补充要求后继续。",
  aborted: "已停止",
};
export function outcomeText(m: ChatMessage): string | null {
  if (!m.outcome || m.outcome === "completed" || m.outcome === "error") return null;
  return OUTCOME_TEXT[m.outcome] || `本次执行结束于:${m.outcome}`;
}

/** 简洁模式的一段:几次操作,结尾可能跟着一份报告 */
export interface Segment {
  /** 这一段的操作,不含报告工具本身 */
  tools: ToolCallInfo[];
  /** 结尾那次 report_progress 的参数;这一段没以报告收尾,或参数解析不出来时为 null */
  report: ProgressReport | null;
}

/**
 * 按 parts 的先后把消息切段:遇到一次报告工具调用就「结一段」。
 *
 * 读下来是「做了几件事(图标)→ 交一份阶段小结(卡片)→ 再做几件事 → 本轮小结」。
 * 报告卡的数据直接取调用参数,不等工具结果 —— 结果只是一句「已记录」。
 * 最后一次报告之后还有操作的话,它们单独成一段,没有卡片。
 */
export function segmentsOf(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  let tools: ToolCallInfo[] = [];
  for (const p of parts) {
    if (p.kind !== "tool") continue;
    // 对用户说的话(send_message 发给 user)画在气泡里,不算操作
    if (isUserMessageCall(p.name, p.input)) continue;
    if (isReportTool(p.name)) {
      out.push({ tools, report: parseProgressReport(p.input) });
      tools = [];
    } else {
      tools.push(p);
    }
  }
  if (tools.length) out.push({ tools, report: null });
  return out;
}

const REPORT_GROUPS = [
  { field: "done", label: "已完成", mark: "✓", cls: "is-done" },
  { field: "todo", label: "待办", mark: "○", cls: "is-todo" },
  { field: "problems", label: "问题", mark: "!", cls: "is-problem" },
] as const;

/**
 * 一份报告卡。
 *
 * Agent 的文字回复默认不显示之后,这就是用户读到的「结论」。阶段卡紧凑、退一档;
 * 本轮小结多一圈半透明强调色描边,醒目一点。三组条目空的不显示,全空写一句,别留个空壳。
 *
 * blocked 的那一份要和「本轮小结」长得不一样:球在用户那边,他得看一眼就知道这不是做完了,
 * 而是在等他回话。否则「撞上轮次上限停了」和「在等你」一个样(docs/plan/agent-blind-stop.md)。
 */
export function ReportCard({ r, enter }: { r: ProgressReport; enter?: boolean }) {
  const groups = REPORT_GROUPS.filter((g) => r[g.field].length > 0);
  const ref = useRef<HTMLDivElement>(null);
  // 流式里刚交上来的报告淡入(enterMotion);历史里的、分页切回来重新显示的不演。只在挂上来那一刻看一次
  useLayoutEffect(() => {
    if (enter) playEnter(ref.current, "pc-enter-rise");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={`ai-report${r.final ? " is-final" : ""}${r.blocked ? " is-blocked" : ""}`}>
      <div className="ai-report-head">
        {reportTitle(r)}
      </div>
      {groups.length ? (
        groups.map((g) => (
          <div key={g.field} className={`ai-report-group ${g.cls}`}>
            <div className="ai-report-label">
              <span className="ai-report-mark" aria-hidden>{g.mark}</span>
              {g.label}
            </div>
            <ul className="ai-report-list">
              {r[g.field].map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="ai-report-empty">(没有可汇报的内容)</div>
      )}
    </div>
  );
}

/**
 * 「思考与原文」:打开「显示思考」时气泡底部的一块。
 *
 * 文字回复默认不显示了(结论看报告卡),但排查时还得看得到它说了什么、想了什么。
 * 按发生顺序铺:相邻的文字并成一段、相邻的思考并成一段,读起来是「想 → 说 → 再想」。
 * 能折起来:原文往往很长,看完就收,不用去顶栏把开关关掉。
 * 合并了几轮的气泡按轮分节(sections):只在同一轮里并段,只有正在跑的那一轮按流式解析 ——
 * 不然整组几百轮的原文并成一段,每 250ms 整个重新解析一遍。
 */
function RawLog({ sections }: { sections: { key: string; parts: MessagePart[]; live: boolean }[] }) {
  const [open, setOpen] = useState(true);
  const items: { key: string; kind: "text" | "thinking"; text: string; live: boolean }[] = [];
  for (const sec of sections) {
    let local = 0;
    let last: (typeof items)[number] | null = null;
    for (const p of sec.parts) {
      if (p.kind !== "text" && p.kind !== "thinking") continue;
      if (last && last.kind === p.kind) last.text += p.kind === "thinking" ? "\n\n" + p.text : p.text;
      else {
        last = { key: `${sec.key}:${local++}`, kind: p.kind, text: p.text, live: sec.live };
        items.push(last);
      }
    }
  }
  if (!items.some((it) => it.text.trim())) return null;
  return (
    <div className="ai-rawlog">
      <button type="button" className="ai-rawlog-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        思考与原文
      </button>
      {open && (
        <div className="ai-rawlog-body">
          {items.map((it) => {
            if (!it.text.trim()) return null;
            // 文字一律走 LiveMarkdown:流式时逐 token 全量解析 Markdown / KaTeX 会把界面卡死
            return it.kind === "text" ? (
              <div key={it.key} className="ai-message-text">
                <LiveMarkdown text={it.text} live={it.live} />
              </div>
            ) : (
              <div key={it.key} className="ai-rawlog-thinking">{it.text}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}


/**
 * 一轮回复的气泡:只放 Agent「在做什么」(2026-10-20 用户定,原话「气泡里面只展示在做什么」)。
 *
 * 按先后列出它用 send_message(to: "user")说的话;一次都没调、只回了文字的,那段文字当一句话(src/ai/userMessages.ts)。
 * 跑着的时候底下一行转圈写着此刻在做什么;出错、停下、云端渲染的进展照旧写在最下面。
 * 做过的操作、看过的画面、汇报(本轮小结)不在气泡里,在气泡下面的「Agent 操作」里按轮显示(ActivityPanel.tsx);
 * 点气泡就让「Agent 操作」切到这一轮。
 */
export function AgentBubble(props: {
  m: ChatMessage;
  showThinking: boolean;
  /** 「Agent 操作」此刻显示的是不是这一轮 */
  selected?: boolean;
  /** 点气泡:让「Agent 操作」切到这一轮 */
  onSelect?: (id: string) => void;
}) {
  const { m, showThinking, selected, onSelect } = props;
  const parts = partsOf(m);
  const live = !!m.pending;
  const busyTool = live ? runningTool(parts) : null;
  const sayings = sayingsOf(m);
  const ops = live || sayings.length ? 0 : segmentsOf(parts).reduce((n, s) => n + s.tools.length, 0);
  const outcome = live ? null : outcomeText(m);
  const lastText = sayings.length ? sayings[sayings.length - 1] : null;

  return (
    <div
      className={`ai-message assistant${onSelect ? " is-selectable" : ""}${selected ? " is-selected" : ""}`}
      data-pc="agent-bubble"
      data-selected={selected ? "1" : undefined}
      onClick={onSelect ? (e) => {
        // 点在链接、按钮上是它们自己的事;选中文字时不切
        if ((e.target as HTMLElement).closest("a,button,input,textarea")) return;
        if (window.getSelection?.()?.toString()) return;
        onSelect(m.id);
      } : undefined}
    >
      {m.roleId && <div className="pc-role-header"><RoleName roleId={m.roleId} /></div>}
      {m.attachments && m.attachments.length > 0 && (
        <div className="ai-message-attach">[附件: {m.attachments.map((a) => a.name).join(", ")}]</div>
      )}

      {sayings.map((s) => (
        <div key={s.key} className="ai-saying" data-pc="agent-saying" data-from={s.from}>
          {/* 文字回复可能是 Markdown;流式时只有最后那句按流式解析 */}
          <LiveMarkdown text={s.text} live={live && s === lastText && s.from === "text"} />
        </div>
      ))}
      {ops > 0 && !m.error && (
        <div className="ai-saying-none" data-pc="agent-saying-none">做了 {ops} 次操作,详见下方「Agent 操作」</div>
      )}

      {/* 「正在做什么」和下面那行轮次小字包成一块:气泡里各块之间只靠 gap 隔开,这两行要贴得比 gap 近 */}
      {live && (
        <div className="ai-activity-block">
          <div className="ai-activity" role="status" aria-live="polite">
            <span className="ai-spinner" aria-hidden />
            <span className="ai-activity-text">{activityText(m, busyTool)}</span>
            <span className="ai-activity-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
          <LiveProgressMeta m={m} />
        </div>
      )}

      {m.error && <div className="ai-message-error" data-pc="agent-error" role="alert">{m.error}</div>}
      {outcome && <div className="ai-message-outcome">{outcome}</div>}
      {/* 云端对话:改动引出的预渲染重试进展常驻一行(渲染失败不能只藏在「Agent 操作」里) */}
      {m.cloudRender && (
        <div className={m.cloudRender.state === "failed" || m.cloudRender.state === "unavailable" ? "ai-message-error" : "ai-message-outcome"} data-pc="cloud-render-note" data-state={m.cloudRender.state}>
          {m.cloudRender.text}
        </div>
      )}

      {showThinking && <RawLog sections={[{ key: m.id, parts, live }]} />}
    </div>
  );
}
