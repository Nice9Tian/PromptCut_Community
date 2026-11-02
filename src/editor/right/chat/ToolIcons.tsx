import React from "react";
import type { ToolCallInfo } from "../../../ai/types";
import { visualIdOf, ToolVisual } from "../ToolVisual";
import { SttInstallProgress } from "../SttInstallProgress";
import { matchInstallJob, useInstallJobs } from "../../../ai/sttInstallStore";
import { bareToolName, iconRuns, KIND_LABEL, type IconRun } from "./iconRuns";
import "./agent.css";
import { tr } from "../../../i18n/index.ts";

/*
 * The action classification (toolKind / KIND_LABEL) and icon grouping (iconRuns) are pure functions,
 * kept in iconRuns.ts so tests can run directly;
 * they are re-exported as is here, so places that import from ToolIcons need no change.
 */
export { toolKind, bareToolName, KIND_LABEL, iconRuns, ICON_RUN_MAX } from "./iconRuns";
export type { ToolKind, IconRun, ToolPartLike } from "./iconRuns";

/** Duration: milliseconds under one second, one decimal under ten seconds, whole seconds beyond that */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** Squash the result summary into one line. The visualId segment at the start is for the UI to recognize records, not for humans to read, so strip it first */
function summaryLine(summary?: string): string {
  const s = (summary || "")
    .replace(/"visualId"\s*:\s*"v-[0-9a-z]+"\s*,?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s === "{}") return "";
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

/**
 * A tool entry: title row + expandable input args / result / files.
 * Only used when detailed mode ("Detailed" in AI settings) renders items one by one; in concise mode
 * all the details live in the operation detail preview control.
 */
export function ToolDetail(props: {
  t: ToolCallInfo;
  open: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  onToggle: () => void;
  /** The title row also shows the elapsed time and a result summary */
  meta?: boolean;
}) {
  const { t, open, installJobs, onToggle, meta } = props;
  const done = t.ok !== undefined;
  const visualId = done ? visualIdOf(t.summary) : null;
  // Installing an engine downloads several hundred MB and can run for minutes. Folded into a single
  // "stt_install ✓" line, the user would only see a tiny spinner in the chat box, with no idea what
  // is going on or how long it will take.
  // So this renders a control with progress, the same one used by the missing-dependency hint at startup.
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
            For actions with visual records (view image, add card, remove card, edit card, get_gif): show
            visible results first, and tuck inputs and result JSON into "Raw data": that is for debugging
            and shouldn't be the first thing users see when expanding.
          */}
          {visualId ? <ToolVisual id={visualId} /> : null}
          {visualId ? (
            <details className="ai-tool-raw">
              <summary>{tr("Raw data")}</summary>
              <div className="ai-tool-label">{tr("Input")}</div>
              <pre className="ai-tool-pre">{JSON.stringify(t.input || {}, null, 2)}</pre>
              <div className="ai-tool-label">{tr("Result")}</div>
              <pre className="ai-tool-pre wrap">{t.summary}</pre>
            </details>
          ) : (
            <>
              <div className="ai-tool-label">{tr("Input")}</div>
              <pre className="ai-tool-pre">{JSON.stringify(t.input || {}, null, 2)}</pre>
              {t.summary ? (
                <>
                  <div className="ai-tool-label">{tr("Result")}</div>
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

/** Icons in the icon row other than operations: a received Agent message (row start), a phase / turn summary (row end) */
export interface ExtraIcon {
  /** Same as the key of that item in the operation detail preview control */
  key: string;
  /** Class names that decide the background color and glyph, e.g. `ai-op--agent`, `ai-op--summary tone-ok` */
  className: string;
  label: string;
  /** When greater than 1, a ×n badge is shown at the bottom right */
  count?: number;
}

/**
 * The icon row of one run.
 *
 * A call is no longer a 16px small square but an icon the size of small_cube: adjacent operations of
 * the same kind are stacked into one icon (up to 5, see iconRuns), colors tell action types apart,
 * and new ones pop in: the user can see items piling up and won't think it is stuck.
 * A received Agent message is a chat icon at the row start; a phase / turn summary is a green ✓ /
 * yellow ! / red ! icon at the row end.
 * Clicking an icon **does not expand any list here**: all details live in the operation detail
 * preview control in the bubble, and a click only makes it jump to that item.
 */
export function ToolIcons(props: {
  /** The operations of this run, in order; report tools mixed in are fine, they produce no operation icon */
  tools: ToolCallInfo[];
  /** Grouping already computed by the upper layer, to avoid computing it again; computed here if not given */
  runs?: IconRun[];
  /**
   * Prefix of the icon key, of the form `<message id>:i<run index>`. It must start with the message id:
   * the pages of the operation detail preview control use this full key to recognize which icon they
   * belong to.
   */
  keyPrefix: string;
  installJobs: ReturnType<typeof useInstallJobs>;
  /** Extra icon at the row start (a received Agent message) */
  lead?: ExtraIcon | null;
  /** Extra icon at the row end (the summary) */
  tail?: ExtraIcon | null;
  /** The item the control currently shows after the user has clicked / flipped: accent outline + slightly enlarged */
  selectedKey?: string | null;
  /** The item the control currently shows when nothing has been clicked and the message is running: glow only */
  focusKey?: string | null;
  /** Icon click: the upper layer makes the control jump to its item */
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
          // Multi-minute jobs like installing an engine are not made into icons; they have their own progress bar (iconRuns guarantees it forms a run by itself)
          const job = bareToolName(first.name) === "stt_install" ? matchInstallJob(first, installJobs) : undefined;
          if (job) {
            return (
              <div key={key} className="ai-ops-install">
                <SttInstallProgress job={job} compact />
              </div>
            );
          }
          const n = run.items.length;
          const names = [...new Set(run.items.map((i) => bareToolName(tools[i].name)))].join(tr(", "));
          const label = run.state === "err" ? tr("Failed") : KIND_LABEL[run.kind];
          return (
            <button
              key={key}
              type="button"
              className={`ai-op ai-op--${run.kind} is-${run.state}${state(key)}`}
              title={tr("{0}{1}: {2}", label, n > 1 ? ` ×${n}` : "", names)}
              aria-label={tr("{0} {1} times{2}: {3}", label, n, run.state === "run" ? tr(", some in progress") : "", names)}
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
