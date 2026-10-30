import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../ai/types";
import { currentStep } from "../../../ai/thinkingSteps";
import { isReportTool } from "../../../ai/progressReport";
import { partsOf, runningTool } from "./AgentBubble";
import { bareToolName, KIND_LABEL, toolKind } from "./iconRuns";
import "./agent.css";

/**
 * 输入框上方的一条:这一页里正在跑的 Agent 此刻在做哪一步。
 *
 * 以前步骤在气泡里竖排成一串(StepStrip),几十步之后气泡被撑得很长,
 * 真正要看的「现在」沉在最底下,还跟着消息列表一起滚走。改成钉在输入框上方、只显示当前一步:
 * 不管滚到哪里都看得见它在忙什么、忙了多久。
 */

/** 已用时间:一分钟以内「12s」,再长「3m05s」 */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * 条带上的那句话。优先用思考里的步骤标题(模型自己报的进度,最贴近它在想什么);
 * 没有就看正在跑的工具;都没有就是还在想。
 */
export function stripText(m: ChatMessage): string {
  const p = m.progress as Record<string, any> | undefined;
  if (p?.waitingJobs || p?.phase === 'waiting_jobs') {
    return p.text || "上一条消息发起的后台作业（转写、镜头识别等）还在做，做完就处理你这条消息。";
  }
  if (p?.renderQueuePosition || p?.phase === 'render_queued') {
    const pos = p.renderQueuePosition ?? 1;
    return `云端渲染正在给别的项目用，排在第 ${pos} 位，轮到了会接着做。`;
  }
  const parts = partsOf(m);
  const step = currentStep(parts);
  if (step) return step;
  const t = runningTool(parts);
  if (t) return isReportTool(t.name) ? "正在整理小结" : `正在${KIND_LABEL[toolKind(t.name)]}:${bareToolName(t.name)}`;
  return "正在思考…";
}

export function ThinkingStrip(props: { messages: ChatMessage[]; streaming: boolean }) {
  const { messages, streaming } = props;
  // 只看最后一条还在跑的 Agent 消息。分工模式下可能好几条同时 pending,条带只有一行,跟最新的那条
  let m: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const x = messages[i];
    if (x.role === "assistant" && x.pending) {
      m = x;
      break;
    }
  }
  const active = !!m && (streaming || !!m.pending);

  const [now, setNow] = useState(() => Date.now());
  // 开始时间优先用消息自带的 startedAt;老数据没有就记第一次看到这条消息的时刻
  const seenAt = useRef<{ id: string; at: number } | null>(null);
  if (m && seenAt.current?.id !== m.id) seenAt.current = { id: m.id, at: m.startedAt ?? Date.now() };

  // 已用时间每秒刷新;不在跑就停表,别让一个看不见的计时器一直唤醒整个面板
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!m || !active) return null;
  const text = stripText(m);
  const startedAt = m.startedAt ?? seenAt.current?.at ?? now;

  return (
    <div className="ai-tstrip">
      <span className="ai-tstrip-dot" aria-hidden />
      <span className="ai-tstrip-textwrap" role="status" aria-live="polite">
        {/* key 跟着文字走:换一步就重新挂载,淡入动画重放一次 */}
        <span key={text} className="ai-tstrip-text" title={text}>
          {text}
        </span>
      </span>
      <span className="ai-tstrip-time" title="已用时间">
        {fmtElapsed(now - startedAt)}
      </span>
    </div>
  );
}
