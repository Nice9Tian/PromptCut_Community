import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatMessage, InboundAgentMessage, ToolCallInfo } from "../../../ai/types";
import { useInstallJobs } from "../../../ai/sttInstallStore";
import { isReportTool, parseProgressReport, reportTitle, type ProgressReport } from "../../../ai/progressReport";
import { isUserMessageCall } from "../../../ai/userMessages";
import { ToolDetail, ToolIcons, type ExtraIcon } from "./ToolIcons";
import { bareToolName, iconRuns, type IconRun } from "./iconRuns";
import { OpDetailPreview, SUMMARY_TONE_TEXT, useDetailPages, type DetailItem, type SummaryTone } from "./OpDetailPreview";
import { ReportCard, partsOf, segmentsOf } from "./AgentBubble";
import { inboundPlan, promptOf } from "./rowPlan";
import type { RowHandlers } from "./MessageList";
import type { ViewMode } from "./viewPrefs";
import "./agent.css";

/**
 * AI 栏底部的「Agent 操作」:原来气泡里的那套可视化(操作图标组、操作详细预览、阶段 / 本轮小结),按轮显示。
 *
 * 2026-10-20 用户定,原话「把Agent操作记录哪里换成气泡里面那个可视化组件。气泡里面只展示在做什么」。
 * 取代原来的「Agent 操作记录」(src/editor/sync/AgentEventLog.tsx:按项目频道列工具事件,来源不限于这个对话,
 * 会混进别的对话、别的成员、命令行的调用)。这里只看这个对话自己的消息,一次显示一轮:缺省跟着最新的一轮,
 * 点哪个气泡就切到哪一轮,也能用 ‹ › 前后翻。写了项目的那一步在操作详细预览里照旧有「撤销这步」(AgentUndoButton)。
 */

const OPEN_KEY = "pc.ai.activity.open";
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeOpen(v: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {
    /* 存不了就只在这一次有效 */
  }
}

/**
 * 「Agent 操作」显示哪一轮:用户点过的那一轮;没点过、或点的那一轮已经不在了,就是最新的一轮。
 * 有新的一轮开始(最新一轮换了)时回到跟踪最新。
 */
export function useRoundSelection(messages: readonly ChatMessage[]): { id: string | null; select: (id: string) => void } {
  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i].id;
    return null;
  }, [messages]);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const [picked, setPicked] = useState<{ id: string; latestAt: string | null } | null>(null);
  const select = useCallback((id: string) => setPicked({ id, latestAt: latestRef.current }), []);
  const valid = picked && picked.latestAt === latest && messages.some((m) => m.id === picked.id && m.role === "assistant");
  return { id: valid ? picked.id : latest, select };
}

type RowSeg = { tools: ToolCallInfo[]; report: ProgressReport | null; runs: IconRun[]; tone: SummaryTone | null };

/** 一轮的可视化:简洁模式是图标组 + 操作详细预览;详细模式按发生顺序列每次操作和汇报卡 */
function RoundActivity(props: {
  m: ChatMessage;
  inbound?: InboundAgentMessage[];
  view: ViewMode;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  on: RowHandlers;
}) {
  const { m, inbound, view, installJobs, expanded, on } = props;
  const parts = partsOf(m);
  const live = !!m.pending;
  const prefix = m.id;
  const segments = useMemo(() => segmentsOf(parts), [parts]);
  const inboundIcon: ExtraIcon | null = inbound?.length
    ? { key: `${prefix}:in`, className: "ai-op--agent", label: `收到 ${inbound.length} 条其他 Agent 的消息`, count: inbound.length }
    : null;
  const segs: RowSeg[] = segments.map((s, si) => ({
    tools: s.tools,
    report: s.report,
    runs: iconRuns(s.tools),
    // 小结的颜色:这一轮出错收尾(最后一段的小结)是红,报了问题是黄,否则绿
    tone: s.report ? (si === segments.length - 1 && (m.error || m.outcome === "error") ? "err" : s.report.problems.length || s.report.blocked ? "warn" : "ok") : null,
  }));
  const items: DetailItem[] = [];
  if (inbound?.length) items.push({ type: "inbound", key: `${prefix}:in`, messages: inbound });
  segs.forEach((seg, si) => {
    for (const run of seg.runs) {
      const tools = run.items.map((i) => seg.tools[i]);
      // 装引擎在图标行里有自己的进度条,不进操作详细预览
      if (bareToolName(tools[0].name) === "stt_install") continue;
      items.push({ type: "run", key: `${prefix}:i${si}:${run.key}`, tools });
    }
    if (seg.report && seg.tone) items.push({ type: "report", key: `${prefix}:i${si}:report`, report: seg.report, tone: seg.tone });
  });
  const pages = useDetailPages(items);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [interacted, setInteracted] = useState(false);
  const [jump, setJump] = useState<{ key: string; seq: number } | null>(null);
  const onToggleIcon = (key: string) => {
    setInteracted(true);
    setFocusKey(key);
    setJump((j) => ({ key, seq: (j?.seq ?? 0) + 1 }));
  };
  const onPage = useCallback((key: string, byUser: boolean) => {
    setFocusKey(key);
    if (byUser) setInteracted(true);
  }, []);
  const selectedKey = interacted ? focusKey : null;
  const glowKey = !interacted && live ? focusKey : null;
  const reportIcon = (seg: RowSeg, si: number): ExtraIcon | null => {
    if (!seg.report || !seg.tone) return null;
    const title = reportTitle(seg.report);
    return { key: `${prefix}:i${si}:report`, className: `ai-op--summary tone-${seg.tone}`, label: `${title}:${SUMMARY_TONE_TEXT[seg.tone]}` };
  };

  if (!segs.length && !inboundIcon) {
    // 出错留痕:失败的一轮不能只写「没有操作」,要说明是因为失败,并带上原因
    if (!live && (m.error || m.outcome === "error")) {
      return (
        <div className="ai-activity-empty is-failed" data-pc="agent-activity-empty" data-failed="1">
          这一轮失败了,没有执行任何操作{m.error ? `:${m.error}` : "。"}
        </div>
      );
    }
    return <div className="ai-activity-empty" data-pc="agent-activity-empty">{live ? "还没有操作" : "这一轮没有操作"}</div>;
  }

  if (view === "verbose") {
    return (
      <div className="ai-activity-verbose">
        {parts.map((p, pidx) => {
          if (p.kind === "status") return <div key={pidx} className="ai-tool-chip info">信息: {p.text}</div>;
          if (p.kind !== "tool" || isUserMessageCall(p.name, p.input)) return null;
          if (isReportTool(p.name)) {
            const r = parseProgressReport(p.input);
            if (r) return <ReportCard key={pidx} r={r} enter={live} />;
          }
          const key = `${m.id}:${pidx}`;
          return <ToolDetail key={key} t={p as ToolCallInfo} open={expanded.has(key)} installJobs={installJobs} onToggle={() => on.toggleTool(key)} />;
        })}
      </div>
    );
  }

  return (
    <>
      {segs.length === 0 && inboundIcon ? (
        <ToolIcons tools={[]} runs={[]} keyPrefix={`${prefix}:i0`} installJobs={installJobs} lead={inboundIcon}
          selectedKey={selectedKey} focusKey={glowKey} onToggleIcon={onToggleIcon} />
      ) : null}
      {segs.map((seg, si) => (
        <ToolIcons
          key={si}
          tools={seg.tools}
          runs={seg.runs}
          keyPrefix={`${prefix}:i${si}`}
          installJobs={installJobs}
          lead={si === 0 ? inboundIcon : null}
          tail={reportIcon(seg, si)}
          selectedKey={selectedKey}
          focusKey={glowKey}
          onToggleIcon={onToggleIcon}
        />
      ))}
      <OpDetailPreview pages={pages} items={items} jump={jump} onPage={onPage} live={live} />
    </>
  );
}

export function AgentActivityPanel(props: {
  messages: ChatMessage[];
  /** 显示哪一轮(useRoundSelection 给的) */
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: ViewMode;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  on: RowHandlers;
}) {
  const { messages, selectedId, onSelect, view, installJobs, expanded, on } = props;
  const [open, setOpen] = useState(readOpen);
  const plan = useMemo(() => inboundPlan(messages), [messages]);
  const rounds = useMemo(() => messages.filter((m) => m.role === "assistant"), [messages]);
  if (!rounds.length) return null;
  const idx = Math.max(0, rounds.findIndex((m) => m.id === selectedId));
  const m = rounds[idx] ?? rounds[rounds.length - 1];
  const prompt = promptOf(messages, m.id, plan);
  const promptText = (prompt?.text ?? "").replace(/\s+/g, " ").trim();
  const ops = segmentsOf(partsOf(m)).reduce((n, s) => n + s.tools.length, 0);

  return (
    <div className="pc-activity" data-pc="agent-activity" data-round-id={m.id} data-round-index={idx + 1}>
      <div className="pc-activity-head">
        <button
          type="button"
          className="pc-activity-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            writeOpen(!open);
          }}
        >
          <span>{open ? "▾" : "▸"} Agent 操作</span>
          <span className="pc-activity-count">第 {idx + 1}/{rounds.length} 轮 · {ops} 次操作{m.pending ? " · 进行中" : ""}</span>
        </button>
        <button type="button" className="pc-activity-nav" data-pc="agent-activity-prev" aria-label="上一轮" title="上一轮"
          disabled={idx <= 0} onClick={() => onSelect(rounds[idx - 1].id)}>‹</button>
        <button type="button" className="pc-activity-nav" data-pc="agent-activity-next" aria-label="下一轮" title="下一轮"
          disabled={idx >= rounds.length - 1} onClick={() => onSelect(rounds[idx + 1].id)}>›</button>
      </div>
      {open ? (
        <div className="pc-activity-body">
          {promptText ? <div className="pc-activity-prompt" title={promptText}>回应:{promptText}</div> : null}
          {/* 换一轮时整块重挂:操作详细预览翻到哪一页、点过哪个图标都是那一轮自己的 */}
          <RoundActivity key={m.id} m={m} inbound={plan.inboundFor.get(m.id)?.list} view={view} installJobs={installJobs} expanded={expanded} on={on} />
        </div>
      ) : null}
    </div>
  );
}
