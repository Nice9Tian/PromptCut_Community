import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { InstallJob } from "../../ai/sttInstallStore";
import { describe, fractionOf } from "../../ai/sttInstallStore";
import "./SttInstallProgress.css";
import { tr } from "../../i18n/index.ts";

/**
 * Install progress control. Both the missing-dependency prompt at startup and stt_install in the
 * chat window use it, so the two entry points see the same state and the same look.
 *
 * The progress bar is determinate only when the denominator is really known (downloading a single
 * file); other phases use an indeterminate animation. How many packages will be installed is not
 * known until pip has resolved the dependencies, so no overall percentage is made up here.
 */
export function SttInstallProgress(props: { job: InstallJob; compact?: boolean }) {
  const { job, compact } = props;
  const [now, setNow] = useState(Date.now());
  const [logOpen, setLogOpen] = useState(false);
  // If the system has "reduce motion" on, don't sweep back and forth; the CSS shows it as a static
  // light bar
  const reduceMotion = useReducedMotion();

  // The stopwatch has to tick on its own: the install may go minutes without new logs, and without a
  // heartbeat the UI looks frozen
  useEffect(() => {
    if (job.phase === "done" || job.phase === "failed") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job.phase]);

  const fraction = fractionOf(job);
  const running = job.phase !== "done" && job.phase !== "failed";
  const seconds = Math.floor(((job.finishedAt ?? now) - job.startedAt) / 1000);
  const elapsed = seconds >= 60 ? tr("{0} min {1} s", Math.floor(seconds / 60), seconds % 60) : tr("{0} s", seconds);

  return (
    <div className={`stt-install ${job.phase} ${compact ? "is-compact" : ""}`} role="status" aria-live="polite">
      <div className="stt-install-head">
        <span className="stt-install-icon" aria-hidden>
          {job.phase === "done" ? "✓" : job.phase === "failed" ? "✗" : <span className="stt-install-spin" />}
        </span>
        <span className="stt-install-title">
          {job.phase === "done" ? tr("Speech-to-text engine installed") : job.phase === "failed" ? tr("Speech-to-text engine install failed") : tr("Installing speech-to-text engine")}
          <span className="stt-install-engine">{job.engine}</span>
        </span>
        {running && <span className="stt-install-elapsed">{elapsed}</span>}
      </div>

      <div className="stt-install-bar" aria-hidden>
        {fraction === null ? (
          // Indeterminate state: a highlight sweeping back and forth, clearly meaning "moving, but unknown
          // how much remains"
          <motion.div
            className="stt-install-fill is-indeterminate"
            animate={reduceMotion ? undefined : { x: ["-60%", "160%"] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : (
          <motion.div
            className="stt-install-fill"
            initial={false}
            animate={{ width: `${Math.round(fraction * 100)}%` }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          />
        )}
      </div>

      <div className="stt-install-status">
        <span>{describe(job)}</span>
        {job.phase === "downloading" && job.totalMB !== undefined && job.gotMB !== undefined && (
          // Make clear this percentage is for "the current file", not the overall progress
          <span className="stt-install-sub">
            {tr("This file {0}/{1} MB{2}", job.gotMB.toFixed(1), job.totalMB.toFixed(1), job.downloaded > 1 ? tr(" · {0} packages downloaded", job.downloaded) : "")}
          </span>
        )}
        {job.phase === "resolving" && job.downloaded > 0 && (
          <span className="stt-install-sub">{tr("{0} packages downloaded", job.downloaded)}</span>
        )}
      </div>

      {job.phase === "failed" && job.logTail.length > 0 && (
        <details open={logOpen} onToggle={(e) => setLogOpen((e.target as HTMLDetailsElement).open)}>
          <summary>{tr("View install log")}</summary>
          <pre>{job.logTail.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
