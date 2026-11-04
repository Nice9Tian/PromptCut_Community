import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { sttStatus } from "./io/stt";
import { runSttInstall } from "./io/runSttInstall";
import { useInstallJobs } from "../ai/sttInstallStore";
import { SttInstallProgress } from "./right/SttInstallProgress";
import "./DependencyPrompt.css";
import { tr } from "../i18n/index.ts";

const DISMISS_KEY = "pc.deps.sttDismissed";

/**
 * Missing-dependency prompt at startup.
 *
 * The speech-to-text engine is installed on demand (hundreds of MB, not suitable for bundling into
 * the installer), but the user will not know something is missing until they actually click
 * "Captions": prompting then is too late, since they are already waiting for the result. So the
 * check runs once at startup, and if something is missing it tells them what, and whether it can be
 * installed with one click.
 *
 * It is not a modal: it blocks no operation, and if the user does not want to deal with it they click
 * ignore, which is recorded in localStorage so it does not bother them again. Installing the engine
 * is not a prerequisite for using this software, and a must-close dialog should not block the entrance.
 */
export function DependencyPrompt() {
  const [missing, setMissing] = useState<string[] | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });
  const [startError, setStartError] = useState<string | null>(null);
  const jobs = useInstallJobs();
  const job = jobs.at(-1);

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    sttStatus()
      .then((s) => {
        if (!alive) return;
        const absent = Object.entries(s.engines)
          .filter(([, v]) => !v.installed)
          .map(([name]) => name);
        // Having either one of the two engines installed is enough; there is no need to install both
        setMissing(absent.length === Object.keys(s.engines).length ? absent : []);
      })
      // If even the built-in Python is not ready, the "Install" button on this prompt is equally helpless.
      // Rather than give a button that fails when clicked, it is better not to prompt: that is a
      // packaging problem.
      .catch(() => { if (alive) setMissing([]); });
    return () => { alive = false; };
  }, [dismissed]);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* Cannot be remembered in incognito mode, ignore */ }
    setDismissed(true);
  };

  const startInstall = () => {
    setStartError(null);
    try { runSttInstall("faster-whisper"); }
    catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
  };

  // Collapse automatically once installed, so the user does not have to click again
  useEffect(() => {
    if (job?.phase !== "done") return;
    const timer = window.setTimeout(() => setDismissed(true), 2600);
    return () => window.clearTimeout(timer);
  }, [job?.phase]);

  const show = !dismissed && (missing?.length ?? 0) > 0;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="dep-prompt"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        >
          {job && job.phase !== "failed" ? (
            <SttInstallProgress job={job} />
          ) : (
            <>
              <div className="dep-prompt-title">{tr("Missing dependency extension, please install: speech-to-text engine")}</div>
              <div className="dep-prompt-body">
                {tr("Once installed, it can turn speech in videos into a transcript. Auto captions and one-click effects both need it. About a few hundred MB, installed in the app's own directory, without touching the system Python.")}
              </div>
              {job?.phase === "failed" && <div className="dep-prompt-error">{tr("Last install failed: {0}", job.error)}</div>}
              {startError && <div className="dep-prompt-error">{startError}</div>}
              <div className="dep-prompt-actions">
                <button className="dep-prompt-btn is-primary" onClick={startInstall}>
                  {job?.phase === "failed" ? tr("Retry install") : tr("Install")}
                </button>
                <button className="dep-prompt-btn" onClick={dismiss}>{tr("Dismiss")}</button>
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
