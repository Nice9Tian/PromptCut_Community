import React from "react";
import type { ToolCallInfo } from "../../../ai/types";
import { visualIdOf, ToolVisual } from "../ToolVisual";
import { SttInstallProgress } from "../SttInstallProgress";
import { matchInstallJob, useInstallJobs } from "../../../ai/sttInstallStore";
import { bareToolName, iconRuns, KIND_LABEL, type IconRun } from "./iconRuns";
import "./agent.css";

/*
 * 动作分类(toolKind / KIND_LABEL)和图标分组(iconRuns)是纯函数,放在 iconRuns.ts 里好直接跑测试;
 * 这里原样转出去,从 ToolIcons 导入的地方不用改。
 */
export { toolKind, bareToolName, KIND_LABEL, iconRuns, ICON_RUN_MAX } from "./iconRuns";
export type { ToolKind, IconRun, ToolPartLike } from "./iconRuns";

/** 耗时:一秒以内给毫秒,十秒以内一位小数,再长取整秒 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** 结果摘要压成一行。开头那截 visualId 是给界面认记录用的,不是给人读的,先摘掉 */
function summaryLine(summary?: string): string {
  const s = (summary || "")
    .replace(/"visualId"\s*:\s*"v-[0-9a-z]+"\s*,?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s === "{}") return "";
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

/**
 * 一个工具片段:标题行 + 可展开的入参 / 结果 / 文件。
 * 只有详细模式(AI 设置里的「详细」)逐条渲染时用;简洁模式的详细内容都在操作详细预览控件里。
 */
export function ToolDetail(props: {
  t: ToolCallInfo;
  open: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  onToggle: () => void;
  /** 标题行再带上耗时和结果摘要 */
  meta?: boolean;
}) {
  const { t, open, installJobs, onToggle, meta } = props;
  const done = t.ok !== undefined;
  const visualId = done ? visualIdOf(t.summary) : null;
  // 装引擎要下好几百 MB、可能跑几分钟。折成一行「stt_install ✓」的话,
  // 用户看到的就是聊天框里一个转圈的小字,不知道在干什么、还要多久。
  // 这里换成带进度的控件,和启动时那个缺依赖提示用的是同一个。
  const installJob = bareToolName(t.name) === "stt_install" ? matchInstallJob(t, installJobs) : undefined;

  if (installJob) {
    return <SttInstallProgress job={installJob} compact />;
  }

  const line = meta && done ? summaryLine(t.summary) : "";

  return (
    <div className="ai-tool-block">
      <div
        className={`ai-tool-chip ${t.ok === true ? "ok" : t.ok === false ? "err" : ""}${meta ? " has-meta" : ""}`}
        onClick={onToggle}
      >
        {done ? (t.ok ? "✓" : "✗") : <span className="ai-spinner" aria-hidden />}
        <span className="ai-tool-name">{bareToolName(t.name)}</span>
        {meta && typeof t.durationMs === "number" ? <span className="ai-tool-dur">{fmtDuration(t.durationMs)}</span> : null}
        {line ? <span className="ai-tool-sum">{line}</span> : null}
        <span className="ai-tool-caret">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="ai-tool-detail">
          {/*
            有可视化记录的(看图、加卡、删卡、改卡、get_gif):先给看得见的结果,
            入参和结果的 JSON 收进「原始数据」—— 那是调试用的,不该是用户点开看到的第一样东西。
          */}
          {visualId ? <ToolVisual id={visualId} /> : null}
          {visualId ? (
            <details className="ai-tool-raw">
              <summary>原始数据</summary>
              <div className="ai-tool-label">入参</div>
              <pre className="ai-tool-pre">{JSON.stringify(t.input || {}, null, 2)}</pre>
              <div className="ai-tool-label">结果</div>
              <pre className="ai-tool-pre wrap">{t.summary}</pre>
            </details>
          ) : (
            <>
              <div className="ai-tool-label">入参</div>
              <pre className="ai-tool-pre">{JSON.stringify(t.input || {}, null, 2)}</pre>
              {t.summary ? (
                <>
                  <div className="ai-tool-label">结果</div>
                  <pre className="ai-tool-pre wrap">{t.summary}</pre>
                </>
              ) : null}
            </>
          )}
          {t.files && t.files.length > 0 ? (
            <div className="ai-tool-files">
              {t.files.map((f, fidx) => {
                const lower = f.toLowerCase();
                const isImg =
                  lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg");
                if (!isImg) {
                  return (
                    <div key={fidx} className="ai-tool-file">
                      {f}
                    </div>
                  );
                }
                const url =
                  f.startsWith("http") || f.startsWith("data:")
                    ? f
                    : `/@fs/${f.replace(/\\/g, "/").replace(/^\/?/, "")}`;
                return (
                  <div key={fidx}>
                    <img
                      src={url}
                      className="ai-tool-img"
                      alt={f}
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        if (e.currentTarget.nextSibling) return;
                        const span = document.createElement("div");
                        span.className = "ai-tool-file";
                        span.textContent = f;
                        e.currentTarget.parentElement?.appendChild(span);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 图标行里操作之外的图标:收到的 Agent 消息(行首)、阶段 / 本轮小结(行尾) */
export interface ExtraIcon {
  /** 和操作详细预览控件里那一项的 key 一样 */
  key: string;
  /** 决定底色和字形的类名,如 `ai-op--agent`、`ai-op--summary tone-ok` */
  className: string;
  label: string;
  /** 大于 1 时右下角标 ×n */
  count?: number;
}

/**
 * 一段的图标行。
 *
 * 一次调用不再是一个 16px 的小方块,而是 small_cube 大小的图标:相邻的同类操作叠进同一个图标
 * (最多 5 个,见 iconRuns),颜色区分动作类型,新的会弹出来 —— 用户看得见条目在变多,不会以为卡住了。
 * 收到的 Agent 消息是行首一个对话图标,阶段 / 本轮小结是行尾一个绿 ✓ / 黄 ! / 红 ! 的图标。
 * 点图标**不在这里摊开任何清单**:所有详细内容都在气泡里那个操作详细预览控件里,点一下只让它跳到这一项。
 */
export function ToolIcons(props: {
  /** 这一段的操作,按先后顺序;报告工具混在里面也没关系,不出操作图标 */
  tools: ToolCallInfo[];
  /** 上层已经算好的分组,省得再算一遍;不给就在这里算 */
  runs?: IconRun[];
  /**
   * 图标 key 的前缀,形如 `<消息id>:i<段号>`。必须以消息 id 开头:
   * 操作详细预览控件的页靠这个完整 key 认出自己属于哪个图标。
   */
  keyPrefix: string;
  installJobs: ReturnType<typeof useInstallJobs>;
  /** 行首的额外图标(收到的 Agent 消息) */
  lead?: ExtraIcon | null;
  /** 行尾的额外图标(小结) */
  tail?: ExtraIcon | null;
  /** 用户点过 / 翻过之后,控件当前显示的那一项:强调色描边 + 略放大 */
  selectedKey?: string | null;
  /** 还没点过、消息在跑时,控件当前显示的那一项:只发光 */
  focusKey?: string | null;
  /** 点图标:上层让控件跳到它那一项 */
  onToggleIcon: (key: string) => void;
}) {
  const { tools, keyPrefix, installJobs, lead, tail, selectedKey, focusKey, onToggleIcon } = props;
  const runs = props.runs ?? iconRuns(tools);
  if (!runs.length && !lead && !tail) return null;
  const state = (key: string) => `${selectedKey === key ? " is-selected" : ""}${focusKey === key ? " is-focus" : ""}`;
  const extra = (x: ExtraIcon) => (
    <button
      key={x.key}
      type="button"
      className={`ai-op ${x.className}${state(x.key)}`}
      title={x.label}
      aria-label={x.label}
      data-pc-op={x.key}
      onClick={() => onToggleIcon(x.key)}
    >
      {x.count && x.count > 1 ? <span className="ai-op-count" aria-hidden>×{x.count}</span> : null}
    </button>
  );

  return (
    <div className="ai-ops-wrap">
      <div className="ai-ops">
        {lead ? extra(lead) : null}
        {runs.map((run) => {
          const key = `${keyPrefix}:${run.key}`;
          const first = tools[run.items[0]];
          // 装引擎那种几分钟的活儿不做成图标,它有自己的进度条(iconRuns 保证它单独成一个)
          const job = bareToolName(first.name) === "stt_install" ? matchInstallJob(first, installJobs) : undefined;
          if (job) {
            return (
              <div key={key} className="ai-ops-install">
                <SttInstallProgress job={job} compact />
              </div>
            );
          }
          const n = run.items.length;
          const names = [...new Set(run.items.map((i) => bareToolName(tools[i].name)))].join("、");
          const label = run.state === "err" ? "失败" : KIND_LABEL[run.kind];
          return (
            <button
              key={key}
              type="button"
              className={`ai-op ai-op--${run.kind} is-${run.state}${state(key)}`}
              title={`${label}${n > 1 ? ` ×${n}` : ""}：${names}`}
              aria-label={`${label} ${n} 次${run.state === "run" ? ",有进行中的" : ""}:${names}`}
              data-pc-op={key}
              onClick={() => onToggleIcon(key)}
            >
              {n > 1 ? <span className="ai-op-count" aria-hidden>×{n}</span> : null}
            </button>
          );
        })}
        {tail ? extra(tail) : null}
      </div>
    </div>
  );
}
