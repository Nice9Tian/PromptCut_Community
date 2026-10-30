/**
 * AI 栏的「Agent 操作记录」(D2,c65-design.md 第 7 节:页面 AI 栏按事件 id 更新对应记录,列表虚拟化)。
 *
 * 数据是文档服务项目频道上的工具调用事件(`events.event`,Agent 服务端每个工具调用发「创建」「完成」两条),
 * syncManager 按 `eventId` 合成一条记录、只留摘要;完整参数在内容库,不在这里拉。
 * 不论这次调用来自本页面的聊天、命令行(`/api/mcp/call`)、别的页面还是共享项目里别人的 Agent,都会出现在这里。
 *
 * 写进了项目的那一条(完成事件带 `opId`)有「撤销这步」(c65-undo-draft.md 第 4 节):不二次确认,不是最新一步也能点,
 * 撤成功后变灰「已撤销」;以本页面的身份提交逆操作 + `undoOf`,进用户自己的撤销栈(c65-design.md 第 8 节裁定)。
 *
 * 列表虚拟化:行高固定,只渲染可见的几行(加上下各几行余量),记录再多也只有十几个 DOM 节点。
 */
import { useMemo, useRef, useState, type UIEvent } from "react";
import { agentOpOfEvent, displayNames, eventRecordList, me, revertAgentOp, useSync, type EventRecord } from "./syncManager";
import { writerLabel } from "./labels";
import "./sync.css";

const ROW_H = 30;
const VIEW_ROWS = 7;
const OVERSCAN = 4;
const OPEN_KEY = "pc.ai.eventLog.open";

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

function statusMark(r: EventRecord): { ch: string; cls: string; title: string } {
  if (r.kind === "text") return { ch: "…", cls: "text", title: "文字回复" };
  if (r.status === null) return { ch: "●", cls: "running", title: "进行中" };
  if (r.status === "ok") return { ch: "✓", cls: "ok", title: "完成" };
  if (r.status === "cancelled") return { ch: "—", cls: "error", title: "取消了" };
  return { ch: "✕", cls: "error", title: "出错了" };
}

function Row({ r, top }: { r: EventRecord; top: number }) {
  const mark = statusMark(r);
  const who = r.actor ? writerLabel({ actor: r.actor, session: r.actor.session as string | undefined }, me(), displayNames()) : "";
  const op = r.opId ? agentOpOfEvent(r.eventId) : null;
  const done = op?.state === "done";
  const label = r.kind === "text" ? (r.text ?? "").replace(/\s+/g, " ").slice(0, 80) : r.tool ?? "?";
  const target = r.target ? r.target.replace(/^[a-zA-Z]+Id:/, "") : "";
  const title = [label, target, who, r.summary ?? "", typeof r.durationMs === "number" ? `${Math.round(r.durationMs)} ms` : ""].filter(Boolean).join(" · ");
  return (
    <div className="pc-evlog-row" style={{ top, height: ROW_H }} data-pc="agent-event" data-event-id={r.eventId} data-status={mark.cls} title={title}>
      <span className={`pc-evlog-mark pc-evlog-mark--${mark.cls}`} aria-label={mark.title}>
        {mark.ch}
      </span>
      <span className="pc-evlog-tool">{label}</span>
      {target ? <span className="pc-evlog-target">{target}</span> : null}
      <span className="pc-evlog-who">{who}</span>
      {op ? (
        <button type="button" className="pc-dialog-opt pc-evlog-undo" data-pc="agent-undo" disabled={done} onClick={() => revertAgentOp(op)}>
          {done ? "已撤销" : "撤销这步"}
        </button>
      ) : null}
    </div>
  );
}

export function AgentEventLog() {
  const active = useSync((v) => v.active);
  const version = useSync((v) => v.eventsVersion);
  useSync((v) => v.agentOpsVersion);
  const [open, setOpen] = useState(readOpen);
  const [scrollTop, setScrollTop] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const records = useMemo(() => eventRecordList().filter((r) => r.kind === "tool"), [version]);
  if (!active || records.length === 0) return null;

  const total = records.length;
  const height = Math.min(total, VIEW_ROWS) * ROW_H;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const shown = records.slice(first, last);

  return (
    <div className="pc-evlog" data-pc="agent-event-log">
      <button
        type="button"
        className="pc-evlog-head"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          writeOpen(!open);
        }}
      >
        <span>{open ? "▾" : "▸"} Agent 操作记录</span>
        <span className="pc-evlog-count">{total} 条</span>
      </button>
      {open ? (
        <div
          ref={boxRef}
          className="pc-evlog-box"
          style={{ height }}
          onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ position: "relative", height: total * ROW_H }}>
            {shown.map((r, i) => (
              <Row key={r.eventId} r={r} top={(first + i) * ROW_H} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
